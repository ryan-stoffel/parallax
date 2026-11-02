//! Dictation's cleanup (PLX-1232). The app transcribes speech on the device, then asks plxd to
//! tidy the text with the user's small model, as a thread's name is written (0058).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Params of `voice/clean`: a dictated transcript to tidy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCleanParams {
    /// What the speech transcribed to.
    pub text: String,
    /// The instance whose small model answers, the one the message is going to. Without a small
    /// model there, the first instance by name that has one answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub backend: Option<String>,
}

/// Result of `voice/clean`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCleanResult {
    /// The tidied text.
    pub text: String,
}
