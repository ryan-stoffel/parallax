//! `plxd mcp --thread <runId>`: a thread's Parallax tools, as an MCP server on stdio (decisions
//! 0019 and 0041). The tools are [`thread`]'s, with [`question`]'s for a Project's threads and
//! [`memory`]'s by the caller's role (0044); this module is the server they share.
//!
//! A Project's coordinator gets the same server as any thread (PLX-380): its 0019 tools, bound to
//! one project, are gone.
//!
//! MCP's stdio transport is JSON-RPC 2.0 as newline-delimited JSON, the same framing as plxd's
//! own protocol (0007), so both sides use `parallax_protocol`'s codec and envelope. Every tool
//! call goes through one [`Plxd`] client, which keeps one connection to plxd's socket and sends
//! concurrent calls on it, matched by id (PLX-488). When plxd restarts or the connection drops,
//! the next call opens a new one and reads plxd's capabilities again. A call already sent fails
//! with its connection, except `thread_wait`, which keeps trying until its deadline. The client
//! stops using a connection it hasn't written to for 75 s, so it needs no heartbeat to stay
//! under plxd's idle timeout. It never starts plxd: the thread it serves is plxd's own child.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use futures_util::stream::FuturesUnordered;
use futures_util::{SinkExt, StreamExt};
use parallax_protocol::framing::{FrameCodec, FrameError};
use parallax_protocol::jsonrpc::{
    ErrorObject, INVALID_REQUEST, Message, Request, RequestId, Response,
};
use parallax_protocol::methods::{AgentEvents, Initialize, RequestMethod};
use parallax_protocol::{
    AgentEventsParams, AgentOutcome, AgentOutputItem, Capabilities, ClientInfo, InitializeParams,
    InitializeResult, ParallaxEvent, ProtocolRange, RunId,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite, ReadHalf, WriteHalf};
use tokio::sync::oneshot;
use tokio::task::AbortHandle;
use tokio_util::codec::{FramedRead, FramedWrite};

use crate::transport::{self, Stream};

pub mod land;
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

/// The most tool calls the server runs at once. Each has at most one request in flight to plxd,
/// so staying under plxd's 32 per connection means long waits never fill the connection.
pub const MAX_CALLS: usize = 16;

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
    // Requests are answered concurrently, each as it finishes, so a long `thread_wait` doesn't
    // hold up the calls after it. At `MAX_CALLS` the server stops reading until one finishes.
    // Once `input` ends, the ones read are still answered.
    let mut answering = FuturesUnordered::new();
    let mut reading = true;
    loop {
        let response = tokio::select! {
            frame = reader.next(), if reading && answering.len() < MAX_CALLS => {
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
                        answering.push(async move {
                            Response {
                                id: Some(request.id.clone()),
                                result: answer(binding, &request).await,
                            }
                        });
                        continue;
                    }
                    Ok(Message::Notification(_) | Message::Response(_)) => continue,
                    Err(malformed) => malformed.into_response(),
                }
            }
            Some(response) = answering.next() => response,
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

/// The longest `plxd mcp` keeps using a connection it hasn't written to: under plxd's 90 s idle
/// timeout, so plxd never closes a connection just as a call is sent on it, and over the 60 s an
/// `agent/wait` takes, so a waiting `thread_wait` keeps its connection.
const IDLE: Duration = Duration::from_secs(75);

/// `plxd mcp`'s client of plxd, shared by every tool call: one connection, opened by the first
/// call, and again by the next call after it closes. Calls on it run concurrently, matched to
/// their answers by id. Past plxd's limit of requests in flight on one connection, plxd stops
/// reading, and later calls wait.
#[derive(Clone)]
pub struct Plxd {
    socket: PathBuf,
    connection: Arc<tokio::sync::Mutex<Option<Arc<Connection>>>>,
    next_id: Arc<AtomicI64>,
}

/// One `initialize`d connection to plxd. Its reader task hands each answer to its caller.
struct Connection {
    writer: tokio::sync::Mutex<FramedWrite<WriteHalf<Stream>, FrameCodec>>,
    state: Arc<Mutex<State>>,
    reader: AbortHandle,
    /// plxd has `agent/wait` (`agentWait`, PLX-451).
    agent_wait: bool,
}

struct State {
    /// Each request's caller, by id, until its answer arrives. `None` once the connection is lost.
    waiting: Option<HashMap<RequestId, oneshot::Sender<Response>>>,
    /// When a request was last written.
    written: Instant,
}

/// Errors from plxd are its message: the model reads them, and nothing matches on them.
impl Plxd {
    /// A client of the plxd at `socket`. It connects on its first call.
    #[must_use]
    pub fn new(socket: PathBuf) -> Self {
        Self {
            socket,
            connection: Arc::default(),
            next_id: Arc::default(),
        }
    }

    /// Whether plxd has `agent/wait`, as it said when the connection opened.
    async fn agent_wait(&self) -> Result<bool, String> {
        Ok(self.connect().await?.agent_wait)
    }

    async fn call<M: RequestMethod>(&self, params: M::Params) -> Result<M::Result, String> {
        self.request::<M>(params)
            .await?
            .map_err(|error| error.message)
    }

    /// Sends one request: plxd's answer, or `Err` when the connection fails first. A request
    /// that couldn't be written is sent once more, on a new connection; one that was written
    /// fails with its connection.
    async fn request<M: RequestMethod>(
        &self,
        params: M::Params,
    ) -> Result<Result<M::Result, ErrorObject>, String> {
        let id = RequestId::Number(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let request = Request::new::<M>(id, params);
        let mut retried = false;
        loop {
            let connection = self.connect().await?;
            match connection.send(&request).await {
                Ok(answer) => {
                    let response = answer.await.map_err(|_| lost(&"plxd closed it"))?;
                    return Ok(response.into_result());
                }
                Err(error) if retried => return Err(lost(&error)),
                Err(_) => {
                    connection.close();
                    retried = true;
                }
            }
        }
    }

    /// The open connection, or a new one when it closed or has been idle for [`IDLE`].
    async fn connect(&self) -> Result<Arc<Connection>, String> {
        let mut current = self.connection.lock().await;
        if let Some(connection) = current.as_ref()
            && connection.usable()
        {
            return Ok(Arc::clone(connection));
        }
        let connection = Arc::new(Connection::open(&self.socket).await?);
        *current = Some(Arc::clone(&connection));
        Ok(connection)
    }
}

impl Connection {
    async fn open(socket: &Path) -> Result<Self, String> {
        let stream = transport::connect(socket)
            .await
            .map_err(|error| format!("could not reach plxd at {}: {error}", socket.display()))?;
        let (read, write) = tokio::io::split(stream);
        let state = Arc::new(Mutex::new(State {
            waiting: Some(HashMap::new()),
            written: Instant::now(),
        }));
        let reader = tokio::spawn(answer_callers(
            FramedRead::new(read, FrameCodec::new()),
            Arc::clone(&state),
        ));
        let mut connection = Self {
            writer: tokio::sync::Mutex::new(FramedWrite::new(write, FrameCodec::new())),
            state,
            reader: reader.abort_handle(),
            agent_wait: false,
        };
        let request = Request::new::<Initialize>(
            0,
            InitializeParams {
                protocol: ProtocolRange::SUPPORTED,
                client: ClientInfo {
                    name: "plxd mcp".to_owned(),
                    version: crate::version().to_owned(),
                    machine_id: None,
                },
                capabilities: Capabilities::default(),
            },
        );
        let answer = connection
            .send(&request)
            .await
            .map_err(|error| lost(&error))?;
        let initialized: InitializeResult = answer
            .await
            .map_err(|_| lost(&"plxd closed it"))?
            .into_result()
            .map_err(|error| error.message)?;
        connection.agent_wait = initialized.capabilities.0.contains_key("agentWait");
        Ok(connection)
    }

    /// Writes `request`: a receiver for its answer, or `Err` when it wasn't written.
    async fn send<P: Serialize>(
        &self,
        request: &Request<P>,
    ) -> Result<oneshot::Receiver<Response>, String> {
        let (answer, answered) = oneshot::channel();
        lock(&self.state)
            .waiting
            .as_mut()
            .ok_or("plxd closed it")?
            .insert(request.id.clone(), answer);
        let sent = self.writer.lock().await.send(request).await;
        let mut state = lock(&self.state);
        if let Err(error) = sent {
            if let Some(waiting) = state.waiting.as_mut() {
                waiting.remove(&request.id);
            }
            return Err(error.to_string());
        }
        state.written = Instant::now();
        Ok(answered)
    }

    fn usable(&self) -> bool {
        let state = lock(&self.state);
        state.waiting.is_some() && state.written.elapsed() < IDLE
    }

    /// Fails every call waiting on this connection, and keeps more from using it.
    fn close(&self) {
        lock(&self.state).waiting = None;
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

/// Reads `frames` until the connection ends, giving each answer to its caller, then fails the
/// calls still waiting.
async fn answer_callers(
    mut frames: FramedRead<ReadHalf<Stream>, FrameCodec>,
    state: Arc<Mutex<State>>,
) {
    while let Some(Ok(frame)) = frames.next().await {
        match Message::from_frame(&frame) {
            Ok(Message::Response(response)) => {
                let caller = response
                    .id
                    .as_ref()
                    .and_then(|id| lock(&state).waiting.as_mut()?.remove(id));
                if let Some(caller) = caller {
                    let _ = caller.send(response);
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    lock(&state).waiting = None;
}

fn lost(error: &dyn std::fmt::Display) -> String {
    format!("the connection to plxd failed: {error}")
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
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
