use rusqlite::{OptionalExtension, TransactionBehavior, params};
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// An image sent with a run's message (RYA-191, decision 0026): its file type as the protocol
/// spells it, such as `image/png`, and its bytes in base64, as the client sent them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredImage {
    pub media_type: String,
    pub data: String,
}

impl Store {
    /// Stores the images of one of `run_id`'s messages under their ids, in one transaction.
    ///
    /// # Errors
    ///
    /// A database error, including an id `run_id` already has.
    pub fn add_images(
        &mut self,
        run_id: Uuid,
        images: &[(Uuid, StoredImage)],
    ) -> Result<(), StoreError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = timestamp::now();
        for (id, image) in images {
            tx.execute(
                "INSERT INTO images (run_id, id, media_type, data, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    run_id.to_string(),
                    id.to_string(),
                    image.media_type,
                    image.data,
                    now
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// `run_id`'s image `id`, or `None` if it has no such image.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn image(&self, run_id: Uuid, id: Uuid) -> Result<Option<StoredImage>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT media_type, data FROM images WHERE run_id = ?1 AND id = ?2",
                params![run_id.to_string(), id.to_string()],
                |row| {
                    Ok(StoredImage {
                        media_type: row.get(0)?,
                        data: row.get(1)?,
                    })
                },
            )
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::StoredImage;
    use crate::Store;

    #[test]
    fn images_are_stored_per_run() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        let (run, other_run, id) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        let image = StoredImage {
            media_type: "image/png".to_owned(),
            data: "iVBORw0KGgo=".to_owned(),
        };

        store.add_images(run, &[(id, image.clone())]).unwrap();
        assert_eq!(store.image(run, id).unwrap(), Some(image));
        assert_eq!(store.image(other_run, id).unwrap(), None);
    }
}
