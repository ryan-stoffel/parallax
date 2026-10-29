//! `pr/uploadMedia` (PLX-1020), behind the `prWatch` capability: plxd commits screenshots and
//! recordings to the host's secret media gist (PLX-1137), one upload at a time per host, and
//! answers with links pinned to each file's blob and Markdown to paste into a pull request's body.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Params of `pr/uploadMedia`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrUploadMediaParams {
    /// The GitHub pull request URL the files are for.
    pub url: String,
    /// The files, in order.
    pub files: Vec<PrMediaFile>,
}

/// A file to upload in [`PrUploadMediaParams`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrMediaFile {
    /// Its absolute path on the host: an image or a video, at most 25 MB.
    pub path: String,
    /// The embed's text. The file's name when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub caption: Option<String>,
}

/// Result of `pr/uploadMedia`: each file, in the order asked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrUploadMediaResult {
    /// The files.
    pub files: Vec<PrMediaUploaded>,
}

/// An uploaded file in [`PrUploadMediaResult`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrMediaUploaded {
    /// The path asked for.
    pub path: String,
    /// `https://gist.githubusercontent.com/<owner>/<gist id>/raw/<blob>/<name>`.
    pub url: String,
    /// `![caption](url)` for an image, `[caption](url)` for a video.
    pub markdown: String,
    /// Whether the same bytes were uploaded to the repository before, so no upload was made.
    pub reused: bool,
}
