//! Saved secrets (0105, PLX-1558), behind the `savedSecrets` capability: secrets the user saves
//! in Settings for every thread on the host, by name, until they expire. `secret/list`,
//! `secret/save`, and `secret/delete` are the app's, and `secret/use` is the `use_secret` tool's.
//! No method returns a value.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RunId;

/// A saved secret, without its value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SavedSecret {
    /// Its id, a UUID.
    pub id: String,
    /// The name agents use it by.
    pub name: String,
    /// When it was saved.
    pub created_at: Timestamp,
    /// When it is deleted. Absent keeps it until the user deletes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expires_at: Option<Timestamp>,
}

/// Params of `secret/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretListParams {}

/// Result of `secret/list`: every saved secret, by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretListResult {
    /// The secrets.
    pub secrets: Vec<SavedSecret>,
}

/// Params of `secret/save`: saves `value` as `name`, replacing a secret saved as `name`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretSaveParams {
    /// The name agents use it by.
    pub name: String,
    /// The value, which goes to the host's keystore.
    pub value: String,
    /// When to delete it, in the future. Absent keeps it until the user deletes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expires_at: Option<Timestamp>,
}

// Never print the value, whoever formats it.
impl std::fmt::Debug for SecretSaveParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretSaveParams")
            .field("name", &self.name)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

/// Params of `secret/delete`. An unknown id changes nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretDeleteParams {
    /// The secret's id.
    pub id: String,
}

/// Result of `secret/save` and `secret/delete`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretSavedResult {}

/// Params of `secret/use`: writes saved secret `name` to a private file for run `runId`'s
/// commands, as `secret/request` with `delivery: file` does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretUseParams {
    /// The run whose commands read it.
    pub run_id: RunId,
    /// The saved secret's name.
    pub name: String,
}

/// Result of `secret/use`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretUseResult {
    /// The path of an owner-only file holding the value, which the run's commands can read for
    /// 24 hours.
    pub file: String,
}
