//! Disposable host-only routing adapter. No production build includes this module.
use super::*;
use futures_util::{SinkExt as _, StreamExt as _};

#[derive(Debug)]
pub(super) struct Carrier {
    send: mpsc::Sender<Message>,
    streams: Arc<tokio::sync::Mutex<HashMap<String, mpsc::Sender<Message>>>>,
}

pub(super) async fn start(
    url: &str,
    host: &str,
    token: &str,
    stop: CancellationToken,
) -> Result<Carrier, Error> {
    let mut socket = websocket(
        url,
        &format!("/v1/hosts/{host}/proof-data?token={token}"),
        &[],
    )
    .await?;
    if next_json(&mut socket).await?["t"] != "ready" {
        return Err(Error::Protocol("proof carrier not ready".into()));
    }
    let (send, mut outgoing) = mpsc::channel::<Message>(16);
    let streams = Arc::new(tokio::sync::Mutex::new(HashMap::<
        String,
        mpsc::Sender<Message>,
    >::new()));
    let peers = Arc::clone(&streams);
    tokio::spawn(async move {
        let (mut sink, mut incoming) = socket.split();
        loop {
            tokio::select! {
                () = stop.cancelled() => break,
                message = outgoing.recv() => {
                    let Some(message) = message else { break };
                    if sink.send(message).await.is_err() { break; }
                }
                frame = incoming.next() => {
                    let (id, message) = match frame {
                        Some(Ok(Message::Binary(bytes))) if bytes.len() >= 64 && bytes.len() <= 64 + MAX_STREAM_FRAME => {
                            (String::from_utf8_lossy(&bytes[..64]).into_owned(), Message::binary(bytes[64..].to_vec()))
                        }
                        Some(Ok(Message::Text(text))) => {
                            let Ok(m) = serde_json::from_str::<Value>(&text) else { break };
                            let Some(id) = m["id"].as_str() else { break };
                            let message = match m["t"].as_str() {
                                Some("ready") => Message::text("ready"),
                                Some("fin") => Message::Close(None),
                                _ => break,
                            };
                            (id.to_owned(), message)
                        }
                        _ => break,
                    };
                    let peer = peers.lock().await.get(&id).cloned();
                    if let Some(peer) = peer {
                        // Bounded queues. A slow stream blocks this serial feasibility carrier.
                        if time::timeout(STREAM_CHECK, peer.send(message)).await.is_err() { break; }
                    }
                }
            }
        }
        peers.lock().await.clear();
        let _ = sink.close().await;
    });
    Ok(Carrier { send, streams })
}

impl Carrier {
    pub(super) async fn open(
        &self,
        id: &str,
        token: &str,
    ) -> Result<WebSocketStream<Stream>, Error> {
        let (ours, theirs) = tokio::io::duplex(MAX_STREAM_FRAME);
        let client = WebSocketStream::from_raw_socket(
            Box::new(ours) as Stream,
            tungstenite::protocol::Role::Client,
            None,
        )
        .await;
        let server =
            WebSocketStream::from_raw_socket(theirs, tungstenite::protocol::Role::Server, None)
                .await;
        let (send, mut receive) = mpsc::channel::<Message>(16);
        {
            let mut streams = self.streams.lock().await;
            if streams.len() >= 16 || streams.contains_key(id) {
                return Err(Error::Protocol("proof native stream limit".into()));
            }
            streams.insert(id.to_owned(), send);
        }
        let joined = self
            .send
            .send(Message::text(
                json!({"t":"join", "id":id, "token":token}).to_string(),
            ))
            .await
            .map_err(|_| Error::Protocol("proof carrier lost".into()));
        if let Err(error) = joined {
            self.streams.lock().await.remove(id);
            return Err(error);
        }
        let outgoing = self.send.clone();
        let streams = Arc::clone(&self.streams);
        let id = id.to_owned();
        tokio::spawn(async move {
            let (mut sink, mut frames) = server.split();
            let mut closing = false;
            loop {
                tokio::select! {
                    frame = receive.recv() => {
                        let Some(frame) = frame else { break };
                        let closed = frame.is_close();
                        if sink.send(frame).await.is_err() || closed { break; }
                    }
                    frame = frames.next(), if !closing => {
                        let message = match frame {
                            Some(Ok(Message::Binary(bytes))) if bytes.len() <= MAX_STREAM_FRAME => {
                                let mut frame = id.as_bytes().to_vec(); frame.extend_from_slice(&bytes);
                                Message::binary(frame)
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                let _ = outgoing.send(Message::text(json!({"t":"fin", "id":id}).to_string())).await;
                                closing = true;
                                // Keep the bridge until the ordered relay FIN acknowledgment.
                                continue;
                            }
                            Some(Ok(_)) => continue,
                            Some(Err(_)) => break,
                        };
                        if outgoing.send(message).await.is_err() { break; }
                    }
                }
            }
            streams.lock().await.remove(&id);
        });
        Ok(client)
    }
}
