//! `plxd mcp --thread <runId>`: a thread's Parallax tools, as an MCP server on stdio (decisions
//! 0019 and 0041). The tools are [`thread`]'s, with [`question`]'s for a Project's threads and
//! [`memory`]'s by the caller's role (0044); this module is the server they share.
//!
//! A Project's coordinator gets the same server as any thread (PLX-380): its 0019 tools, bound to
//! one project, are gone.
//!
//! MCP's stdio transport is JSON-RPC 2.0 as newline-delimited JSON, the same framing as plxd's
//! own protocol (0007), so both sides use `parallax_protocol`'s codec and envelope. Each tool call
//! opens its own connection to plxd's socket, initializes, and makes one or more calls, so the
//! server needs no heartbeat and outlives a plxd restart between calls. It never starts plxd:
//! the thread it serves is plxd's own child.

use std::path::Path;

use futures_util::{SinkExt, StreamExt};
use parallax_protocol::framing::{FrameCodec, FrameError};
use parallax_protocol::jsonrpc::{
    ErrorObject, INVALID_REQUEST, Message, Request, RequestId, Response,
};
use parallax_protocol::methods::{AgentEvents, Initialize, RequestMethod};
use parallax_protocol::{
    AgentEventsParams, AgentOutcome, AgentOutputItem, Capabilities, ClientInfo, InitializeParams,
    ParallaxEvent, ProtocolRange, RunId,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::codec::{Framed, FramedRead, FramedWrite};

use crate::transport::{self, Stream};

pub mod memory;
pub mod question;
pub mod thread;

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

/// One server's tools: what `tools/list` shows, and how `tools/call` runs one.
trait Tools {
    /// Every tool's name, as [`Tools::definitions`] lists them.
    fn names(&self) -> Vec<&'static str>;
    /// `tools/list`'s `tools`.
    fn definitions(&self) -> Value;
    /// Runs tool `name`, one of [`Tools::names`]: its text, or an error the model sees.
    async fn call(&self, name: &str, arguments: Value) -> Result<String, String>;
}

async fn serve(
    binding: &impl Tools,
    input: impl AsyncRead + Unpin,
    output: impl AsyncWrite + Unpin,
) -> Result<(), String> {
    let mut reader = FramedRead::new(input, FrameCodec::with_max_frame_bytes(MAX_MESSAGE_BYTES));
    let mut writer = FramedWrite::new(output, FrameCodec::new());
    while let Some(frame) = reader.next().await {
        let frame = match frame {
            Ok(frame) => frame,
            Err(FrameError::TooLarge { max_frame_bytes }) => {
                let message = format!("a message is longer than {max_frame_bytes} bytes");
                let error = ErrorObject::new(INVALID_REQUEST, message.clone());
                let _ = writer.send(&Response::error(None, error)).await;
                return Err(message);
            }
            Err(error) => return Err(error.to_string()),
        };
        let response = match Message::from_frame(&frame) {
            Ok(Message::Request(request)) => Response {
                id: Some(request.id.clone()),
                result: answer(binding, &request).await,
            },
            Ok(Message::Notification(_) | Message::Response(_)) => continue,
            Err(malformed) => malformed.into_response(),
        };
        writer
            .send(&response)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
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

#[derive(Deserialize)]
struct ToolCall {
    name: String,
    #[serde(default)]
    arguments: Option<Value>,
}

/// A `tools/call` result: the text, and whether it reports a failure the model should see.
fn tool_result(outcome: Result<String, String>) -> Value {
    let (text, is_error) = match outcome {
        Ok(text) => (text, false),
        Err(text) => (text, true),
    };
    json!({
        "content": [{"type": "text", "text": clip(&text, MAX_RESULT_BYTES)}],
        "isError": is_error,
    })
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
async fn last_output(plxd: &mut Plxd, run_id: RunId) -> Result<Option<String>, String> {
    let mut after = 0;
    let mut last = None;
    loop {
        let page = plxd
            .call::<AgentEvents>(AgentEventsParams {
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

/// One connection to plxd: `initialize`d, then calls in order.
struct Plxd {
    framed: Framed<Stream, FrameCodec>,
    next_id: i64,
}

/// Errors from plxd are its message: the model reads them, and nothing matches on them.
impl Plxd {
    async fn open(socket: &Path) -> Result<Self, String> {
        let stream = transport::connect(socket)
            .await
            .map_err(|error| format!("could not reach plxd at {}: {error}", socket.display()))?;
        let mut plxd = Self {
            framed: Framed::new(stream, FrameCodec::new()),
            next_id: 0,
        };
        plxd.call::<Initialize>(InitializeParams {
            protocol: ProtocolRange::SUPPORTED,
            client: ClientInfo {
                name: "plxd mcp".to_owned(),
                version: crate::version().to_owned(),
                machine_id: None,
            },
            capabilities: Capabilities::default(),
        })
        .await?;
        Ok(plxd)
    }

    async fn call<M: RequestMethod>(&mut self, params: M::Params) -> Result<M::Result, String> {
        self.next_id += 1;
        let id = RequestId::Number(self.next_id);
        let lost =
            |error: &dyn std::fmt::Display| format!("the connection to plxd failed: {error}");
        self.framed
            .send(&Request::new::<M>(id.clone(), params))
            .await
            .map_err(|error| lost(&error))?;
        loop {
            let frame = self
                .framed
                .next()
                .await
                .ok_or_else(|| lost(&"plxd closed it"))?
                .map_err(|error| lost(&error))?;
            match Message::from_frame(&frame) {
                Ok(Message::Response(response)) if response.id.as_ref() == Some(&id) => {
                    return response.into_result().map_err(|error| error.message);
                }
                Ok(_) => {}
                Err(error) => return Err(lost(&error)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{clip, tail};

    #[test]
    fn long_text_is_cut_at_a_character_boundary_with_a_note() {
        assert_eq!(clip("short", 10), "short");
        let cut = clip("ééééé", 3);
        assert!(cut.starts_with("é\n[cut: 2 of 10 bytes shown]"), "{cut}");
        let end = tail("ééééé", 3);
        assert!(end.ends_with("\né"), "{end}");
    }
}
