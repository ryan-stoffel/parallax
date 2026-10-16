use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ProtocolRange;
use crate::id::uuid_v7_id;

uuid_v7_id! {
    /// A chunked upload's id (`fileChunks`, decision 0074): a version 7 UUID plxd generates for
    /// a file's first piece, which every later piece names.
    UploadId
}

/// Params of `host/health`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostHealthParams {}

/// Result of `host/health`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostHealthResult {
    /// Seconds since plxd started.
    pub uptime_seconds: u64,
    /// Whether plxd can read and write its project store.
    pub store: StoreState,
    /// Agents with a turn running on this host. An idle session (0060) doesn't count.
    pub running_agents: u32,
    /// How busy the store's job queue is (PLX-445). An older plxd leaves it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub queues: Option<HostQueues>,
}

/// The job queue of plxd's database thread, which runs its jobs one at a time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostQueues {
    /// The project store's thread, which writes rows and their events (0052).
    pub store: QueueStats,
}

/// Counts and times for one job queue since plxd started. Divide a total by `jobs` for the average.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QueueStats {
    /// Jobs sent and not yet started.
    pub queued: u64,
    /// Jobs started.
    pub jobs: u64,
    /// The longest a job sat in the queue before its thread took it, in microseconds.
    pub max_wait_micros: u64,
    /// Every started job's wait, added up, in microseconds.
    pub total_wait_micros: u64,
    /// The longest a job took to run, in microseconds.
    pub max_run_micros: u64,
    /// Every finished job's run time, added up, in microseconds. It leaves out the one running.
    pub total_run_micros: u64,
}

/// The state of plxd's project store.
///
/// A newer plxd may send states that are not listed here. Treat those as unknown, so a `switch`
/// over this type must not end in an exhaustiveness assertion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum StoreState {
    /// The store works.
    Ok,
    /// The store cannot be read or written, so project methods fail.
    Unavailable,
    /// A state this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Params of `host/version`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostVersionParams {}

/// Result of `host/version`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostVersionResult {
    /// plxd's release version.
    pub plxd: String,
    /// The protocol versions plxd speaks.
    pub protocol: ProtocolRange,
    /// The operating system and its version, such as `macOS 27.0`.
    pub os: String,
    /// The CPU architecture, such as `aarch64`.
    pub arch: String,
}

/// Params of `host/update`, behind the `hostUpdate` capability (PLX-700, decision 0066): install
/// plxd `version` from its GitHub release and restart into it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostUpdateParams {
    /// The release to install, such as `2610.10912.13045-nightly`: the app's own version.
    pub version: String,
    /// Restart into it at once, cutting off running agents' turns, instead of once they end
    /// (PLX-746). The host's `continueAfterRestart` then decides whether they go on.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub now: bool,
}

/// Result of `host/update`: plxd installed the release and says when it restarts into it. Every
/// failure, such as a download that fails, a checksum that doesn't match, a version older than
/// plxd's, or a host plxd can't update itself on, is a `hostUpdateFailed` error whose message is
/// for people.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostUpdateResult {
    /// The version plxd installed, or already runs.
    pub version: String,
    /// When plxd hands over to it.
    pub restart: HostUpdateRestart,
    /// Agents with a turn running, which plxd waits for under `afterRuns`.
    pub running_agents: u32,
    /// What happened, for people.
    pub message: String,
}

/// When plxd restarts into the version `host/update` installed.
///
/// A newer plxd may send values that are not listed here. Treat those as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum HostUpdateRestart {
    /// In a moment, right after the answer: connections drop and reconnect to the new plxd.
    Now,
    /// Once the last running agent's turn ends, since restarting would cut it off.
    AfterRuns,
    /// Never: plxd already runs that version, or a newer one with the same number.
    UpToDate,
    /// A value this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Params of `host/folders`, behind the `hostFolders` capability (PLX-769): the folders in a
/// folder on the host, for adding a repository on another computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostFoldersParams {
    /// The folder: an absolute path, or `~` or a path under it, for the home folder of the user
    /// plxd runs as.
    pub path: String,
}

/// Result of `host/folders`. A folder that can't be read fails with `invalidParams`, whose
/// message says why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostFoldersResult {
    /// The folder's absolute path.
    pub path: String,
    /// Its folders, and its symbolic links to folders, by name, ignoring case.
    pub folders: Vec<HostFolder>,
}

/// A folder `host/folders` lists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostFolder {
    /// Its name.
    pub name: String,
    /// Its absolute path.
    pub path: String,
}

/// Params of `host/upload`, behind the `fileUploads` capability (PLX-779, decision 0071): a file
/// the user attached to a message, which plxd saves on the host so the agent can read it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostUploadParams {
    /// Its file name, kept as is. A name with `/`, `\`, or `:`, or that is `.` or `..`, fails
    /// with `invalidParams`.
    pub name: String,
    /// Its bytes, in standard base64 with padding, at most the capability's `maxBytes` long. A
    /// piece's are at most `fileChunks`' `chunkBytes` once decoded.
    pub data: String,
    /// The upload this piece belongs to (`fileChunks`, decision 0074), as the first piece's
    /// answer named it. Absent on the first piece, which starts a new upload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub upload_id: Option<UploadId>,
    /// Where this piece starts in the file, which must be the length received so far: 0 for the
    /// first piece. A gap, a repeated piece, or a file that would grow past `fileChunks`'
    /// `maxBytes` fails with `invalidParams`. Any of `uploadId`, `offset`, and `last` makes the
    /// call a piece; absent means 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub offset: Option<u64>,
    /// Whether this is the file's last piece, after which the file is at `path`. Absent means
    /// false. An upload that gets no piece for an hour is removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last: Option<bool>,
}

/// Result of `host/upload`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostUploadResult {
    /// The saved file's absolute path on the host: `<data folder>/uploads/<id>/<name>`. For a
    /// piece, where the file will be once its last piece arrives.
    pub path: String,
    /// The upload a piece belongs to, for the next piece to name. Absent for a whole file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub upload_id: Option<UploadId>,
}

/// Params of `host/readUpload`, behind `fileUploads` (PLX-779): a file `host/upload` saved, for
/// the transcript to show again.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostReadUploadParams {
    /// The path `host/upload` answered. Any path outside the uploads folder fails with
    /// `invalidParams`, as does one that's gone.
    pub path: String,
    /// Where to start reading, in bytes, for one slice of the file (`fileChunks`, decision
    /// 0074). A slice is read from a file of any size, and never through a symlink. Either of
    /// `offset` and `length` makes the call a slice; absent `offset` means 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub offset: Option<u64>,
    /// How many bytes a slice reads, at most `fileChunks`' `chunkBytes`, which is also the
    /// default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub length: Option<u64>,
}

/// Result of `host/readUpload`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostReadUploadResult {
    /// The file's bytes, or a slice's, in standard base64 with padding. A slice past the end is
    /// empty.
    pub data: String,
    /// The whole file's size in bytes, for a slice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size: Option<u64>,
}

/// Params of `host/settings/get`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostSettingsGetParams {}

/// Params of `host/settings/set`: changes the settings it names and leaves the rest.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostSettingsSetParams {
    /// The new `autoResume`. Absent leaves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auto_resume: Option<bool>,
    /// The new `continueAfterRestart`. Absent leaves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub continue_after_restart: Option<bool>,
    /// The new `cleanWorktrees`, behind the `worktreeCleanup` capability. Absent leaves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub clean_worktrees: Option<bool>,
    /// The new `connect`, behind the `connect` capability. Absent leaves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub connect: Option<bool>,
    /// The new `remote`, behind the `remote` capability. Absent leaves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub remote: Option<bool>,
    /// The new `remoteWeb`, behind the `remoteWeb` capability. Absent leaves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub remote_web: Option<bool>,
    /// The new `relay`, behind the `relay` capability. Absent leaves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub relay: Option<bool>,
    /// The new `deviceName`, behind the `connect` capability. `""` clears it. Control characters
    /// are dropped and the rest trimmed to at most 64 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub device_name: Option<String>,
    /// The new `deviceIcon`, behind the `connect` capability: `laptop`, `desktop`, `mini`, or
    /// `server`, and `""` clears it. Anything else is invalid params.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub device_icon: Option<String>,
}

/// This host's settings, the result of `host/settings/get` and `host/settings/set`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostSettings {
    /// Whether a run a usage limit stopped waits for the limit to reset and then resumes
    /// (PLX-371, decision 0049). Off by default (0060). A run's own `autoResume` overrides it.
    /// Turning it off stops a waiting run from resuming when its timer fires.
    pub auto_resume: bool,
    /// Whether a plain thread's turn that a plxd restart cut off gets "Continue where you left
    /// off." once plxd is up (0060). Off by default. A Project's runs always continue. An older
    /// plxd leaves it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub continue_after_restart: Option<bool>,
    /// Whether plxd removes a settled or archived thread's worktree and local branch once its
    /// linked pull requests have merged (PLX-555). On by default. The thread and its transcript
    /// stay. An older plxd, without the `worktreeCleanup` capability, leaves it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub clean_worktrees: Option<bool>,
    /// Whether plxd listens for this user's other devices on its Tailscale address (decision
    /// 0056). Off by default. An older plxd, without the `connect` capability, leaves it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub connect: Option<bool>,
    /// Whether plxd listens for paired clients over HTTPS on port 7341 (PLX-641, 0065). Off by
    /// default. An older plxd, without the `remote` capability, leaves it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub remote: Option<bool>,
    /// Whether the HTTPS listener also serves the app as a web client at `/`, and pairs browsers
    /// with the short code (PLX-651). Off by default, and only in effect while `remote` is on. An
    /// older plxd, without the `remoteWeb` capability, leaves it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub remote_web: Option<bool>,
    /// Whether plxd keeps a connection to Parallax Relay while `remote` is on, so this user's
    /// other devices reach it from anywhere and its webhooks have a public URL (PLX-652, 0068).
    /// Off by default. An older plxd, without the `relay` capability, leaves it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub relay: Option<bool>,
    /// This device's nickname for Parallax Connect, when one is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub device_name: Option<String>,
    /// This device's icon for Parallax Connect, when one is set: `laptop`, `desktop`, `mini`, or
    /// `server`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub device_icon: Option<String>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{HostHealthParams, HostUpdateRestart, HostUpdateResult, StoreState};

    #[test]
    fn update_results_round_trip_and_unknown_restarts_decode_as_unknown() {
        let result = HostUpdateResult {
            version: "2610.10912.13045".to_owned(),
            restart: HostUpdateRestart::AfterRuns,
            running_agents: 2,
            message: "Installed plxd 2610.10912.13045.".to_owned(),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(
            value,
            json!({
                "version": "2610.10912.13045",
                "restart": "afterRuns",
                "runningAgents": 2,
                "message": "Installed plxd 2610.10912.13045."
            })
        );
        assert_eq!(
            serde_json::from_value::<HostUpdateResult>(value).unwrap(),
            result
        );
        for (restart, name) in [
            (HostUpdateRestart::Now, "now"),
            (HostUpdateRestart::UpToDate, "upToDate"),
        ] {
            assert_eq!(serde_json::to_value(restart).unwrap(), json!(name));
        }
        assert_eq!(
            serde_json::from_value::<HostUpdateRestart>(json!("atLogin")).unwrap(),
            HostUpdateRestart::Unknown
        );
    }

    #[test]
    fn unknown_store_states_decode_as_unknown() {
        assert_eq!(
            serde_json::from_value::<StoreState>(json!("migrating")).unwrap(),
            StoreState::Unknown
        );
        assert_eq!(serde_json::to_value(StoreState::Ok).unwrap(), json!("ok"));
    }

    #[test]
    fn empty_params_accept_future_options() {
        assert_eq!(
            serde_json::from_value::<HostHealthParams>(json!({"verbose": true})).unwrap(),
            HostHealthParams {}
        );
        assert_eq!(
            serde_json::to_value(HostHealthParams {}).unwrap(),
            json!({})
        );
    }
}
