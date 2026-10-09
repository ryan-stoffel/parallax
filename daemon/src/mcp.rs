//! `plxd mcp --thread <runId>`: a thread's Parallax tools, as an MCP server on stdio (decisions
//! 0019 and 0041). The tools are [`thread`]'s, with [`question`]'s for a Project's threads,
//! [`memory`]'s by the caller's role (0044), [`device`]'s (PLX-640), and [`triggers`]' schedule
//! and pull request tools and [`delegation`]'s (0063); this module is the server they share.
//!
//! A Project's coordinator gets the same server as any thread (PLX-380): its 0019 tools, bound to
//! one project, are gone.
//!
//! MCP's stdio transport is JSON-RPC 2.0 as newline-delimited JSON, the same framing as plxd's
//! own protocol (0007), so both sides use `parallax_protocol`'s codec and envelope. Every tool
//! call goes through one [`Plxd`] client, which keeps one connection to plxd's socket and sends
//! concurrent calls on it (PLX-488). It never starts plxd: the thread it serves is plxd's own
//! child. A call the MCP client cancels with `notifications/cancelled` stops, gets no answer, and
//! cancels its plxd request with `$/cancelRequest` (PLX-524).

use std::collections::HashMap;

use futures_util::future::{AbortHandle, Abortable, Aborted};
use futures_util::stream::FuturesUnordered;
use futures_util::{SinkExt, StreamExt};
use parallax_protocol::framing::{FrameCodec, FrameError};
use parallax_protocol::jsonrpc::{
    ErrorObject, INVALID_REQUEST, Message, Request, RequestId, Response,
};
use parallax_protocol::methods::AgentEvents;
use parallax_protocol::{AgentEventsParams, AgentOutcome, AgentOutputItem, ParallaxEvent, RunId};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Semaphore;
use tokio_util::codec::{FramedRead, FramedWrite};

use crate::peer::Plxd;

pub mod delegation;
pub mod device;
pub mod html;
pub mod land;
pub mod memory;
pub mod preview;
pub mod question;
pub mod thread;
pub mod triggers;

/// The server's name in a thread's `--mcp-config`, which prefixes its tools' names there.
pub const SERVER: &str = "plxd";

/// The longest line the server reads from the CLI. A longer one gets an error and ends the
/// server, since the stream can't be trusted to resynchronize after it.
pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

/// The longest task prompt or message, in bytes.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

/// The longest shared context path, in bytes.
pub const MAX_PATH_BYTES: usize = 255;

/// The largest shared context file, in bytes: plxd's own per-file cap (0005).
pub const MAX_CONTEXT_BYTES: usize = 1024 * 1024;

/// The most text one tool result carries, in bytes. The rest is cut, with a note.
pub const MAX_RESULT_BYTES: usize = 256 * 1024;

/// MCP protocol versions the server answers with, newest last. A client asking for another gets
/// the newest; the tools use nothing that differs between them.
const MCP_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/// The longest a tool call can run: `delegate_task`'s `wait` at its longest, an hour, and a
/// minute to spare. Codex's own default is 60 s, so plxd sets this for its server there.
pub const MAX_TOOL_SECONDS: u64 = 61 * 60;

/// The most tool calls the server runs at once. Each has at most one request in flight to plxd,
/// so staying under plxd's 32 per connection means long waits never fill the connection.
pub const MAX_CALLS: usize = 16;

/// One server's tools: what `tools/list` shows, and how `tools/call` runs one.
trait Tools {
    /// Every tool's name, as [`Tools::definitions`] lists them.
    fn names(&self) -> Vec<&'static str>;
    /// `tools/list`'s `tools`.
    fn definitions(&self) -> Value;
    /// Runs tool `name`, one of [`Tools::names`]: its reply, or an error the model sees.
    async fn call(&self, name: &str, arguments: Value) -> Result<Reply, String>;
}

/// A tool's reply: its text, and a PNG the model sees as an image, such as a device's screen.
pub struct Reply {
    /// The text, which is JSON for most tools.
    pub text: String,
    /// The PNG's bytes, if the reply has one.
    pub png: Option<Vec<u8>>,
}

impl From<String> for Reply {
    fn from(text: String) -> Self {
        Self { text, png: None }
    }
}

async fn serve(
    binding: &impl Tools,
    input: impl AsyncRead + Unpin,
    output: impl AsyncWrite + Unpin,
) -> Result<(), String> {
    let mut reader = FramedRead::new(input, FrameCodec::with_max_frame_bytes(MAX_MESSAGE_BYTES));
    let mut writer = FramedWrite::new(output, FrameCodec::new());
    // Requests are answered concurrently, each as it finishes, so a long `thread_wait` doesn't
    // hold up the calls after it. At most `MAX_CALLS` tool calls run at once and the rest wait
    // their turn, while the server keeps reading so a `notifications/cancelled` still gets through
    // (PLX-524). A cancelled request is dropped, which cancels its plxd request, and gets no
    // answer, as MCP says. Once `input` ends, the ones read are still answered.
    // ponytail: calls waiting for a slot queue without bound; cap the queue and stop reading
    // past it if a client ever floods the server.
    let slots = Semaphore::new(MAX_CALLS);
    let mut answering = FuturesUnordered::new();
    let mut cancels = HashMap::new();
    let mut reading = true;
    loop {
        let response = tokio::select! {
            frame = reader.next(), if reading => {
                let frame = match frame {
                    None => {
                        reading = false;
                        continue;
                    }
                    Some(Ok(frame)) => frame,
                    Some(Err(FrameError::TooLarge { max_frame_bytes })) => {
                        let message = format!("a message is longer than {max_frame_bytes} bytes");
                        let error = ErrorObject::new(INVALID_REQUEST, message.clone());
                        let _ = writer.send(&Response::error(None, error)).await;
                        return Err(message);
                    }
                    Some(Err(error)) => return Err(error.to_string()),
                };
                match Message::from_frame(&frame) {
                    Ok(Message::Request(request)) => {
                        let id = request.id.clone();
                        let (cancel, registration) = AbortHandle::new_pair();
                        cancels.insert(id.clone(), cancel);
                        let slots = &slots;
                        let answered = async move {
                            let _slot = match request.method.as_str() {
                                "tools/call" => slots.acquire().await.ok(),
                                _ => None,
                            };
                            Response {
                                id: Some(request.id.clone()),
                                result: answer(binding, &request).await,
                            }
                        };
                        answering.push(async move {
                            (id, Abortable::new(answered, registration).await)
                        });
                        continue;
                    }
                    Ok(Message::Notification(notification)) => {
                        if notification.method == "notifications/cancelled"
                            && let Ok(Cancelled { request_id }) = notification.params()
                            && let Some(cancel) = cancels.get(&request_id)
                        {
                            cancel.abort();
                        }
                        continue;
                    }
                    Ok(Message::Response(_)) => continue,
                    Err(malformed) => malformed.into_response(),
                }
            }
            Some((id, answered)) = answering.next() => {
                cancels.remove(&id);
                match answered {
                    Ok(response) => response,
                    Err(Aborted) => continue,
                }
            }
            else => return Ok(()),
        };
        writer
            .send(&response)
            .await
            .map_err(|error| error.to_string())?;
    }
}

async fn answer(binding: &impl Tools, request: &Request) -> Result<Value, ErrorObject> {
    match request.method.as_str() {
        "initialize" => {
            let asked: InitializeRequest = request.params()?;
            let version = MCP_VERSIONS
                .iter()
                .find(|version| Some(**version) == asked.protocol_version.as_deref())
                .or(MCP_VERSIONS.last())
                .copied();
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER, "version": crate::version()},
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": binding.definitions()})),
        "tools/call" => {
            let call: ToolCall = request.params()?;
            if !binding.names().contains(&call.name.as_str()) {
                return Err(ErrorObject::invalid_params(format!(
                    "no tool is named {:?}",
                    call.name
                )));
            }
            let arguments = call.arguments.unwrap_or_else(|| json!({}));
            Ok(tool_result(binding.call(&call.name, arguments).await))
        }
        other => Err(ErrorObject::method_not_found(other)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeRequest {
    #[serde(default)]
    protocol_version: Option<String>,
}

/// `notifications/cancelled`'s params: the request the client no longer wants answered.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cancelled {
    request_id: RequestId,
}

#[derive(Deserialize)]
struct ToolCall {
    name: String,
    #[serde(default)]
    arguments: Option<Value>,
}

/// A `tools/call` result: the text, any image, and whether it reports a failure the model should
/// see.
fn tool_result(outcome: Result<Reply, String>) -> Value {
    let (reply, is_error) = match outcome {
        Ok(reply) => (reply, false),
        Err(text) => (Reply::from(text), true),
    };
    let mut content = vec![json!({"type": "text", "text": clip(&reply.text, MAX_RESULT_BYTES)})];
    if let Some(png) = reply.png {
        let data = crate::images::encode(&png);
        content.push(json!({"type": "image", "data": data, "mimeType": "image/png"}));
    }
    json!({"content": content, "isError": is_error})
}

/// `text`, cut to at most `max` bytes at a character boundary, with a note when it was cut.
fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let end = text.floor_char_boundary(max);
    format!(
        "{}\n[cut: {} of {} bytes shown]",
        &text[..end],
        end,
        text.len()
    )
}

/// The end of `text`, at most `max` bytes.
fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let start = text.ceil_char_boundary(text.len() - max);
    format!(
        "[cut: last {} of {} bytes]\n{}",
        text.len() - start,
        text.len(),
        &text[start..]
    )
}

fn parse<T: DeserializeOwned>(arguments: Value) -> Result<T, String> {
    serde_json::from_value(arguments).map_err(|error| format!("invalid arguments: {error}"))
}

fn check_text(name: &str, text: &str, max: usize) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    if text.len() > max {
        return Err(format!("{name} must be at most {max} bytes"));
    }
    Ok(())
}

fn pretty(value: &impl serde::Serialize) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|error| error.to_string())
}

/// The run's latest text: its last assistant message or turn result, or how its last CLI process
/// ended.
// ponytail: pages through the run's whole event history on every call; add a from-the-end page
// to agent/events if long runs make thread_wait slow.
async fn last_output(plxd: &Plxd, run_id: RunId) -> Result<Option<String>, String> {
    let mut after = 0;
    let mut last = None;
    loop {
        let page = plxd
            .call::<AgentEvents>(AgentEventsParams {
                before: None,
                run_id,
                after,
                limit: Some(1000),
            })
            .await?;
        for logged in &page.events {
            match &logged.event {
                ParallaxEvent::AgentOutput { items, .. } => {
                    for item in items {
                        match item {
                            AgentOutputItem::Text { text, .. }
                            | AgentOutputItem::TurnFinished {
                                result: Some(text), ..
                            } => last = Some(text.clone()),
                            _ => {}
                        }
                    }
                }
                ParallaxEvent::AgentFinished { outcome, .. } => match outcome {
                    AgentOutcome::Completed { result: Some(text) } => last = Some(text.clone()),
                    AgentOutcome::Failed { message, .. } => last = Some(message.clone()),
                    _ => {}
                },
                _ => {}
            }
        }
        match page.events.last() {
            Some(logged) if page.more => after = logged.seq,
            _ => return Ok(last),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Reply, clip, tail, tool_result};

    #[test]
    fn a_reply_with_a_png_carries_it_as_an_image_block_after_its_text() {
        let png = Some(b"\x89PNG".to_vec());
        let result = tool_result(Ok(Reply {
            text: "{}".to_owned(),
            png,
        }));
        assert_eq!(
            result["content"],
            json!([
                {"type": "text", "text": "{}"},
                {"type": "image", "data": "iVBORw==", "mimeType": "image/png"},
            ])
        );
        assert_eq!(result["isError"], false);
    }

    #[test]
    fn long_text_is_cut_at_a_character_boundary_with_a_note() {
        assert_eq!(clip("short", 10), "short");
        let cut = clip("ééééé", 3);
        assert!(cut.starts_with("é\n[cut: 2 of 10 bytes shown]"), "{cut}");
        let end = tail("ééééé", 3);
        assert!(end.ends_with("\né"), "{end}");
    }
}
