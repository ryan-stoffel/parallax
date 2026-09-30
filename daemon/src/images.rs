//! Images sent with a prompt or message (RYA-191, decision 0026): their caps, which `initialize`
//! advertises as the `promptImages` capability's options, and the checks every method that takes
//! `images` runs before anything is created or sent.

use wisp_protocol::jsonrpc::ErrorObject;
use wisp_protocol::{ErrorKind, ImageMediaType, PromptImage};

/// The most images one message takes.
pub(crate) const MAX_IMAGES: usize = 10;

/// The longest one image's `data` may be, in bytes of base64, about 3.75 MiB of image: the most
/// every Claude platform takes per image, since Anthropic counts its limit on the base64, so an
/// image wispd takes, Claude takes too.
pub(crate) const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// The most a message's images' `data` may add up to, in bytes of base64: what fits in one of
/// 0007's 8 MiB frames beside the longest text wispd takes (1 MiB) and the envelope.
pub(crate) const MAX_TOTAL_BYTES: usize = 6 * 1024 * 1024;

/// Checks a message's images against the caps, with `imageTooLarge`, and checks that each is
/// base64 whose bytes are the file type it names, with `invalidParams`.
pub(crate) fn check(images: &[PromptImage]) -> Result<(), ErrorObject> {
    let too_large = |message: String| ErrorObject::wisp(ErrorKind::ImageTooLarge, message);
    if images.len() > MAX_IMAGES {
        return Err(too_large(format!(
            "a message takes at most {MAX_IMAGES} images, not {}",
            images.len()
        )));
    }
    for (n, image) in (1..).zip(images) {
        if image.data.len() > MAX_IMAGE_BYTES {
            return Err(too_large(format!(
                "image {n} is {} bytes of base64; each must be at most {MAX_IMAGE_BYTES}",
                image.data.len()
            )));
        }
        let Some(bytes) = decode(&image.data) else {
            return Err(ErrorObject::invalid_params(format!(
                "image {n}'s data is not standard base64 with padding"
            )));
        };
        if !is_type(image.media_type, &bytes) {
            return Err(ErrorObject::invalid_params(format!(
                "image {n} is not a PNG, JPEG, GIF, or WebP file of its mediaType"
            )));
        }
    }
    let total: usize = images.iter().map(|image| image.data.len()).sum();
    if total > MAX_TOTAL_BYTES {
        return Err(too_large(format!(
            "a message's images are {total} bytes of base64; they must be at most \
             {MAX_TOTAL_BYTES} in all"
        )));
    }
    Ok(())
}

/// Whether `bytes` start the way a file of `media_type` does.
fn is_type(media_type: ImageMediaType, bytes: &[u8]) -> bool {
    match media_type {
        ImageMediaType::Png => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        ImageMediaType::Jpeg => bytes.starts_with(b"\xff\xd8\xff"),
        ImageMediaType::Gif => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        ImageMediaType::Webp => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        ImageMediaType::Unknown => false,
    }
}

/// Decodes standard base64 with padding, or `None` if `text` isn't that.
pub(crate) fn decode(text: &str) -> Option<Vec<u8>> {
    let text = text.as_bytes();
    if !text.len().is_multiple_of(4) {
        return None;
    }
    let chunks = text.len() / 4;
    let mut out = Vec::with_capacity(chunks * 3);
    for (index, chunk) in text.chunks(4).enumerate() {
        let padding = chunk.iter().rev().take_while(|&&byte| byte == b'=').count();
        if padding > 2 || (padding > 0 && index + 1 < chunks) {
            return None;
        }
        let mut n = 0u32;
        for &byte in &chunk[..4 - padding] {
            let value = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => return None,
            };
            n = (n << 6) | u32::from(value);
        }
        let [_, a, b, c] = (n << (6 * padding)).to_be_bytes();
        out.extend_from_slice(&[a, b, c][..3 - padding]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use wisp_protocol::{ErrorKind, ImageMediaType, PromptImage};

    use super::{MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TOTAL_BYTES, check, decode};

    /// A 1x1 PNG.
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    fn image(media_type: ImageMediaType, data: &str) -> PromptImage {
        PromptImage {
            media_type,
            data: data.to_owned(),
        }
    }

    /// A PNG of `bytes` bytes of base64: the real one, padded out with valid base64 after it.
    fn png_of(bytes: usize) -> PromptImage {
        let mut data = PNG.trim_end_matches('=').to_owned();
        data.truncate(data.len() / 4 * 4);
        data.extend(std::iter::repeat_n('A', bytes - data.len()));
        image(ImageMediaType::Png, &data)
    }

    fn kind(images: &[PromptImage]) -> Option<ErrorKind> {
        check(images).unwrap_err().wisp_data().map(|data| data.kind)
    }

    #[test]
    fn decodes_rfc_4648_vectors_and_refuses_anything_else() {
        for (output, input) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(decode(input).as_deref(), Some(output.as_bytes()), "{input}");
        }
        assert_eq!(decode("//4A").as_deref(), Some(&[0xff, 0xfe, 0x00][..]));
        for bad in ["Zg", "Zg=a", "Z===", "Zg==Zg==", "Zm9v\n", "Zm-v"] {
            assert_eq!(decode(bad), None, "{bad}");
        }
    }

    #[test]
    fn images_under_the_caps_of_their_type_pass() {
        check(&[]).unwrap();
        check(&[image(ImageMediaType::Png, PNG)]).unwrap();
        check(&[
            png_of(MAX_IMAGE_BYTES),
            png_of(MAX_TOTAL_BYTES - MAX_IMAGE_BYTES),
        ])
        .unwrap();
    }

    #[test]
    fn too_many_or_too_large_images_are_image_too_large() {
        let small = image(ImageMediaType::Png, PNG);
        assert_eq!(
            kind(&vec![small; MAX_IMAGES + 1]),
            Some(ErrorKind::ImageTooLarge)
        );
        assert_eq!(
            kind(&[png_of(MAX_IMAGE_BYTES + 4)]),
            Some(ErrorKind::ImageTooLarge)
        );
        assert_eq!(
            kind(&[
                png_of(MAX_IMAGE_BYTES),
                png_of(MAX_TOTAL_BYTES - MAX_IMAGE_BYTES + 4)
            ]),
            Some(ErrorKind::ImageTooLarge)
        );
    }

    #[test]
    fn data_that_is_not_base64_or_not_its_type_is_invalid() {
        for bad in [
            image(ImageMediaType::Png, "not base64"),
            image(ImageMediaType::Jpeg, PNG),
            image(ImageMediaType::Unknown, PNG),
        ] {
            let error = check(&[bad]).unwrap_err();
            assert_eq!(error.code, wisp_protocol::jsonrpc::INVALID_PARAMS);
        }
    }
}
