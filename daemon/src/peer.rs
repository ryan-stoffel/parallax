//! plxd's client of a plxd (0007): `plxd mcp`'s calls to its own plxd, and, over Parallax Connect,
//! another computer's (0056, 0057).
//!
//! Every call goes through one [`Plxd`], which keeps one connection and sends concurrent calls on
//! it, matched by id (PLX-488). How it opens a connection is its connector: [`Plxd::local`] for
//! the local socket, [`Plxd::tailnet`] for a tailnet device's TCP port. When plxd restarts or the
//! connection drops, the next call opens a new one through the connector and reads plxd's
//! capabilities again. A call already sent fails with its connection, except `thread_wait`, which
//! keeps trying until its deadline. A call the MCP client cancels with `notifications/cancelled`
//! stops, gets no answer, and cancels its plxd request with `$/cancelRequest` (PLX-524). It never
//! starts plxd.
//!
//! A client stops using a connection it hasn't written to for 75 s, so `plxd mcp` needs no
//! heartbeat to stay under plxd's idle timeout. A connection to another computer can sit silent
//! while it waits for events, so [`Plxd::notify`] gives it a channel for `events/event`
//! notifications, and a connection with an `events/subscribe` on it is never dropped for idling.
//! A tailnet client sends `host/health` every 30 s on it to keep plxd from closing it, and closes
//! it when plxd stops answering. [`Peers`] keeps one client per device.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use parallax_protocol::framing::FrameCodec;
use parallax_protocol::jsonrpc::{
    CancelRequestParams, ErrorObject, Message, Notification, Request, RequestId, Response,
};
use parallax_protocol::methods::{
    CancelRequest, EventsEvent, EventsSubscribe, HostHealth, Initialize, NotificationMethod,
    RequestMethod,
};
use parallax_protocol::{
    Capabilities, ClientInfo, EventsEventParams, HostHealthParams, InitializeParams,
    InitializeResult, ProtocolRange,
};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_util::codec::{FramedRead, FramedWrite};

use crate::tailnet::Tailnet;
use crate::transport;

/// How long a tailnet device's port has to accept a connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// A byte stream to a plxd: the local socket, or a TCP connection.
trait Io: AsyncRead + AsyncWrite + Send + Unpin {}

impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}

type Stream = Box<dyn Io>;

/// Opens a connection to the plxd a [`Plxd`] calls, each time it needs one, and says who the
/// client is. `Err` says why it couldn't, in words the model can read.
type Connector =
    Arc<dyn Fn() -> BoxFuture<'static, Result<(Stream, ClientInfo), String>> + Send + Sync>;

/// The longest a [`Plxd`] keeps using a connection it hasn't written to: under plxd's 90 s idle
/// timeout, so plxd never closes a connection just as a call is sent on it, and over the 60 s an
/// `agent/wait` takes, so a waiting `thread_wait` keeps its connection.
const IDLE: Duration = Duration::from_secs(75);

/// How often a tailnet client sends `host/health` on a subscribed connection: three times within
/// plxd's idle timeout.
const HEARTBEAT: Duration = Duration::from_secs(30);

/// What a [`Plxd`] hands its [`Plxd::notify`] channel.
#[derive(Debug)]
pub enum Incoming {
    /// An `events/event` notification.
    Event(Box<EventsEventParams>),
    /// A connection opened after an earlier one was lost. The old connection's subscriptions
    /// ended with it, so the caller subscribes again.
    Reconnected,
}

/// When a [`Plxd`] drops a silent connection and when it sends `host/health`.
#[derive(Clone, Copy)]
struct Timing {
    idle: Duration,
    /// `None` for a client that sends no heartbeat.
    heartbeat: Option<Duration>,
}

/// A client of one plxd, shared by every call: one connection, opened by the first call, and
/// again by the next call after it closes. Calls on it run concurrently, matched to
/// their answers by id. Past plxd's limit of requests in flight on one connection, plxd stops
/// reading, and later calls wait.
#[derive(Clone)]
pub struct Plxd {
    connector: Connector,
    connection: Arc<tokio::sync::Mutex<Option<Arc<Connection>>>>,
    next_id: Arc<AtomicI64>,
    timing: Timing,
    /// Where `events/event` notifications go.
    notify: Arc<Mutex<Option<mpsc::UnboundedSender<Incoming>>>>,
    /// A connection has opened, so the next one is a reconnect.
    opened: Arc<AtomicBool>,
}

/// One `initialize`d connection to plxd. Its reader task hands each answer to its caller.
struct Connection {
    writer: tokio::sync::Mutex<FramedWrite<WriteHalf<Stream>, FrameCodec>>,
    state: Arc<Mutex<State>>,
    reader: tokio::task::AbortHandle,
    /// plxd has `agent/wait` (`agentWait`, PLX-451).
    agent_wait: bool,
    /// An `events/subscribe` was answered on it. A subscribed connection is never idle.
    subscribed: AtomicBool,
    idle: Duration,
}

struct State {
    /// Each request's caller, by id, until its answer arrives. `None` once the connection is lost.
    waiting: Option<HashMap<RequestId, oneshot::Sender<Response>>>,
    /// When a request was last written.
    written: Instant,
}

/// Errors from plxd are its message: the model reads them, and nothing matches on them.
impl Plxd {
    /// A client of the plxd that `connector` reaches, and the [`ClientInfo`] it names itself with.
    /// It connects on its first call.
    #[must_use]
    pub fn new<F, Fut, S>(connector: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(S, ClientInfo), String>> + Send + 'static,
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        Self {
            connector: Arc::new(move || {
                let opening = connector();
                Box::pin(async move {
                    let (stream, client) = opening.await?;
                    Ok((Box::new(stream) as Stream, client))
                })
            }),
            connection: Arc::default(),
            next_id: Arc::default(),
            timing: Timing {
                idle: IDLE,
                heartbeat: None,
            },
            notify: Arc::default(),
            opened: Arc::default(),
        }
    }

    /// A client of the plxd at `socket`.
    #[must_use]
    pub fn local(socket: PathBuf) -> Self {
        Self::new(move || {
            let socket = socket.clone();
            async move {
                let stream = transport::connect(&socket).await.map_err(|error| {
                    format!("could not reach plxd at {}: {error}", socket.display())
                })?;
                let client = ClientInfo {
                    name: "plxd mcp".to_owned(),
                    version: crate::version().to_owned(),
                    machine_id: None,
                };
                Ok((stream, client))
            }
        })
    }

    /// A client of the plxd on the tailnet device with node ID `node`, on its Tailscale IPv4 at
    /// `port` (0056). Each connection looks the device up in `tailnet` again, so a changed
    /// address is followed, and refuses a node that isn't one of this node's own devices. The
    /// device decides whether to serve this node. Prefer [`Peers::client`], so a device has one.
    #[must_use]
    pub fn tailnet(tailnet: Arc<dyn Tailnet>, node: String, port: u16) -> Self {
        let mut client = Self::new(move || {
            let tailnet = Arc::clone(&tailnet);
            let node = node.clone();
            async move { dial(&*tailnet, &node, port).await }
        });
        client.timing.heartbeat = Some(HEARTBEAT);
        client
    }

    /// This client with other timing, so a test needn't wait out [`IDLE`] and [`HEARTBEAT`].
    #[must_use]
    pub fn with_timing(mut self, idle: Duration, heartbeat: Option<Duration>) -> Self {
        self.timing = Timing { idle, heartbeat };
        self
    }

    /// Sends every `events/event` notification on any connection of this client to `sender`,
    /// replacing an earlier channel, and [`Incoming::Reconnected`] when a connection replaces a
    /// lost one. The caller subscribes first, after the first call, and again on each
    /// [`Incoming::Reconnected`].
    // ponytail: unbounded, because the reader task can't wait on the caller; bound it and close
    // the connection past a backlog if a caller ever falls behind.
    pub fn notify(&self, sender: mpsc::UnboundedSender<Incoming>) {
        *lock(&self.notify) = Some(sender);
    }

    /// Whether plxd has `agent/wait`, as it said when the connection opened.
    pub(crate) async fn agent_wait(&self) -> Result<bool, String> {
        Ok(self.connect().await?.agent_wait)
    }

    /// Sends one request.
    ///
    /// # Errors
    ///
    /// plxd's error message, or why the connection failed.
    pub async fn call<M: RequestMethod>(&self, params: M::Params) -> Result<M::Result, String> {
        self.request::<M>(params)
            .await?
            .map_err(|error| error.message)
    }

    /// Sends one request: plxd's answer, or `Err` when the connection fails first. A request
    /// that couldn't be written is sent once more, on a new connection; one that was written
    /// fails with its connection. Dropped while plxd is answering, it cancels the request with
    /// `$/cancelRequest` (PLX-524).
    pub(crate) async fn request<M: RequestMethod>(
        &self,
        params: M::Params,
    ) -> Result<Result<M::Result, ErrorObject>, String> {
        let id = RequestId::Number(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let request = Request {
            id,
            method: M::NAME.to_owned(),
            params: Some(crate::commands::with_command_id(M::NAME, params)),
        };
        let mut retried = false;
        loop {
            let connection = self.connect().await?;
            match connection.send(&request).await {
                Ok(answer) => {
                    let mut in_flight =
                        InFlight(Some((Arc::clone(&connection), request.id.clone())));
                    let answered = answer.await;
                    in_flight.0 = None;
                    let response = answered.map_err(|_| lost(&"plxd closed it"))?;
                    if M::NAME == EventsSubscribe::NAME && response.result.is_ok() {
                        connection.subscribed.store(true, Ordering::Relaxed);
                    }
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

    /// The open connection, or a new one when it closed or has been idle. A connection that
    /// can't be opened, such as to a device that is no longer one of this node's own, leaves
    /// no connection behind.
    async fn connect(&self) -> Result<Arc<Connection>, String> {
        let mut current = self.connection.lock().await;
        if let Some(connection) = current.as_ref()
            && connection.usable()
        {
            return Ok(Arc::clone(connection));
        }
        let connection =
            match Connection::open(&self.connector, &self.notify, self.timing.idle).await {
                Ok(connection) => Arc::new(connection),
                Err(error) => {
                    *current = None;
                    return Err(error);
                }
            };
        *current = Some(Arc::clone(&connection));
        if let Some(period) = self.timing.heartbeat {
            tokio::spawn(heartbeat(
                Arc::downgrade(&connection),
                Arc::clone(&self.next_id),
                period,
            ));
        }
        if self.opened.swap(true, Ordering::Relaxed)
            && let Some(sender) = lock(&self.notify).as_ref()
        {
            let _ = sender.send(Incoming::Reconnected);
        }
        Ok(connection)
    }
}

impl Connection {
    async fn open(
        connector: &Connector,
        notify: &Arc<Mutex<Option<mpsc::UnboundedSender<Incoming>>>>,
        idle: Duration,
    ) -> Result<Self, String> {
        let (stream, client) = connector().await?;
        let (read, write) = tokio::io::split(stream);
        let state = Arc::new(Mutex::new(State {
            waiting: Some(HashMap::new()),
            written: Instant::now(),
        }));
        let reader = tokio::spawn(answer_callers(
            FramedRead::new(read, FrameCodec::new()),
            Arc::clone(&state),
            Arc::clone(notify),
        ));
        let mut connection = Self {
            writer: tokio::sync::Mutex::new(FramedWrite::new(write, FrameCodec::new())),
            state,
            reader: reader.abort_handle(),
            agent_wait: false,
            subscribed: AtomicBool::new(false),
            idle,
        };
        let request = Request::new::<Initialize>(
            0,
            InitializeParams {
                protocol: ProtocolRange::SUPPORTED,
                client,
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
        state.waiting.is_some()
            && (self.subscribed.load(Ordering::Relaxed) || state.written.elapsed() < self.idle)
    }

    /// Fails every call waiting on this connection, and keeps more from using it.
    fn close(&self) {
        lock(&self.state).waiting = None;
    }
}

/// A request written on a connection, until its answer arrives. Dropped before then, because its
/// tool call was cancelled, it sends plxd `$/cancelRequest`. plxd still answers it, and
/// [`answer_callers`] drops that answer.
struct InFlight(Option<(Arc<Connection>, RequestId)>);

impl Drop for InFlight {
    fn drop(&mut self) {
        let Some((connection, id)) = self.0.take() else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            let cancel = Notification::new::<CancelRequest>(CancelRequestParams { id });
            let _ = connection.writer.lock().await.send(&cancel).await;
        });
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

/// Reads `frames` until the connection ends, giving each answer to its caller and each
/// `events/event` to `notify`'s channel, then fails the calls still waiting.
async fn answer_callers(
    mut frames: FramedRead<ReadHalf<Stream>, FrameCodec>,
    state: Arc<Mutex<State>>,
    notify: Arc<Mutex<Option<mpsc::UnboundedSender<Incoming>>>>,
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
            Ok(Message::Notification(notification)) if notification.method == EventsEvent::NAME => {
                if let Ok(event) = notification.params()
                    && let Some(sender) = lock(&notify).as_ref()
                {
                    let _ = sender.send(Incoming::Event(Box::new(event)));
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    lock(&state).waiting = None;
}

/// Sends `host/health` on `connection` every `period` while it is subscribed, so plxd's idle
/// timeout doesn't close a connection that only listens. Closes the connection when plxd doesn't
/// answer within `period`, and ends with it.
async fn heartbeat(connection: Weak<Connection>, next_id: Arc<AtomicI64>, period: Duration) {
    loop {
        tokio::time::sleep(period).await;
        let Some(connection) = connection.upgrade() else {
            return;
        };
        if lock(&connection.state).waiting.is_none() {
            return;
        }
        if !connection.subscribed.load(Ordering::Relaxed) {
            continue;
        }
        let id = RequestId::Number(next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let request = Request::new::<HostHealth>(id, HostHealthParams {});
        let Ok(answer) = connection.send(&request).await else {
            connection.close();
            return;
        };
        let answered = tokio::time::timeout(period, answer).await;
        if !matches!(answered, Ok(Ok(_))) {
            connection.close();
            return;
        }
    }
}

fn lost(error: &dyn std::fmt::Display) -> String {
    format!("the connection to plxd failed: {error}")
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A TCP connection to the device `id` on `tailnet`, from its current status. The device has to
/// pass 0056's filter every time: a peer of this node's own user, untagged, while this node is
/// untagged too ([`Status::own_peer`](crate::tailnet::Status::own_peer)). One that was re-tagged
/// or shared out since gets no connection. The client names itself with this node's ID, so the
/// device's log names the peer.
async fn dial(
    tailnet: &dyn Tailnet,
    id: &str,
    port: u16,
) -> Result<(TcpStream, ClientInfo), String> {
    let status = tailnet.status().await.map_err(|error| error.to_string())?;
    let node = status
        .own_peer(id)
        .ok_or_else(|| format!("{id} isn't one of this computer's devices"))?;
    if !node.online {
        return Err(format!("{} is offline", node.host_name));
    }
    let ip = node
        .ipv4()
        .ok_or_else(|| format!("{} has no Tailscale IPv4 address", node.host_name))?;
    let address = SocketAddr::new(ip, port);
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address))
        .await
        .map_err(|_| {
            format!(
                "{} didn't accept a connection at {address} within {CONNECT_TIMEOUT:?}",
                node.host_name
            )
        })?
        .map_err(|error| format!("could not reach {} at {address}: {error}", node.host_name))?;
    let _ = stream.set_nodelay(true);
    let client = ClientInfo {
        name: "plxd".to_owned(),
        version: crate::version().to_owned(),
        machine_id: Some(status.this.id),
    };
    Ok((stream, client))
}

/// The clients of this node's tailnet devices, one per device (0057). 0056 lets a peer address
/// have two pending `whois` checks, so several clients of one device reconnecting at once would
/// be closed.
pub struct Peers {
    tailnet: Arc<dyn Tailnet>,
    port: u16,
    clients: Mutex<HashMap<String, Plxd>>,
}

impl Peers {
    /// Clients of the devices of `tailnet`, each at `port`.
    #[must_use]
    pub fn new(tailnet: Arc<dyn Tailnet>, port: u16) -> Self {
        Self {
            tailnet,
            port,
            clients: Mutex::default(),
        }
    }

    /// The client of the device with node ID `node`: the same one on every call.
    #[must_use]
    pub fn client(&self, node: &str) -> Plxd {
        lock(&self.clients)
            .entry(node.to_owned())
            .or_insert_with(|| Plxd::tailnet(Arc::clone(&self.tailnet), node.to_owned(), self.port))
            .clone()
    }
}
