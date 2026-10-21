use parallax_protocol::{DevicePlatform, DeviceStreamKind};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{Chunked, Listed, Relay, Upstream, get, newest_iphone, relay, upstream_path};

#[test]
fn a_chunked_body_decodes_however_it_is_split() {
    let wire = b"5\r\nhello\r\n7;ext=1\r\n, world\r\n0\r\n\r\n";
    for split in 0..wire.len() {
        let mut chunked = Chunked::default();
        let mut buffer = wire[..split].to_vec();
        let mut out = Vec::new();
        let mut done = chunked.take(&mut buffer, &mut out).unwrap();
        buffer.extend_from_slice(&wire[split..]);
        done |= chunked.take(&mut buffer, &mut out).unwrap();
        assert_eq!(out, b"hello, world", "split at {split}");
        assert!(done, "split at {split}");
    }
    let mut buffer = b"zz\r\n".to_vec();
    assert!(
        Chunked::default()
            .take(&mut buffer, &mut Vec::new())
            .is_err()
    );
}

#[tokio::test]
async fn a_stream_body_arrives_in_pieces_until_its_last_chunk() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 1024];
        let n = socket.read(&mut request).await.unwrap();
        assert!(
            request[..n].starts_with(b"GET /vendor/serve-sim/helper/A/stream.avcc HTTP/1.1\r\n")
        );
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n")
            .await
            .unwrap();
        socket.flush().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        socket.write_all(b"2\r\nde\r\n0\r\n\r\n").await.unwrap();
    });
    let mut body = get(port, "/vendor/serve-sim/helper/A/stream.avcc")
        .await
        .unwrap();
    assert_eq!(body.next().await.unwrap().as_deref(), Some(&b"abc"[..]));
    assert_eq!(body.next().await.unwrap().as_deref(), Some(&b"de"[..]));
    assert_eq!(body.next().await.unwrap(), None);
}

#[test]
fn streams_open_only_the_hubs_stream_routes_with_the_device_encoded() {
    let path = |platform, kind| upstream_path(platform, kind, "EC87/../x?y");
    assert_eq!(
        path(DevicePlatform::Ios, DeviceStreamKind::Video),
        "/vendor/serve-sim/helper/EC87%2F..%2Fx%3Fy/stream.avcc"
    );
    assert_eq!(
        path(DevicePlatform::Ios, DeviceStreamKind::Control),
        "/vendor/serve-sim/helper/ws?device=EC87%2F..%2Fx%3Fy"
    );
    assert_eq!(
        path(DevicePlatform::Android, DeviceStreamKind::Video),
        path(DevicePlatform::Android, DeviceStreamKind::Control)
    );
    assert_eq!(
        upstream_path(
            DevicePlatform::Android,
            DeviceStreamKind::Control,
            "emulator-5554"
        ),
        "/vendor/serve-emu/ws?device=emulator-5554&frame-meta=1"
    );
}

#[test]
fn a_new_simulator_is_the_newest_runtimes_first_pro_iphone() {
    let listed = br#"{"runtimes": [
      {"identifier": "rt.iOS-18-0", "name": "iOS 18.0", "platform": "iOS", "supportedDeviceTypes": []},
      {"identifier": "rt.watchOS", "name": "watchOS 11", "platform": "watchOS", "supportedDeviceTypes": []},
      {"identifier": "rt.iOS-26-5", "name": "iOS 26.5", "platform": "iOS", "supportedDeviceTypes": [
        {"identifier": "t.17ProMax", "name": "iPhone 17 Pro Max", "productFamily": "iPhone"},
        {"identifier": "t.iPad", "name": "iPad Pro", "productFamily": "iPad"},
        {"identifier": "t.17Pro", "name": "iPhone 17 Pro", "productFamily": "iPhone"}
      ]}
    ]}"#;
    let (runtime, kind) = newest_iphone(listed).unwrap();
    assert_eq!(
        (runtime.name.as_str(), kind.identifier.as_str()),
        ("iOS 26.5", "t.17Pro")
    );
    let none = newest_iphone(br#"{"runtimes": []}"#).err().unwrap();
    assert!(none.starts_with("No iOS runtime is installed."), "{none}");
}

#[tokio::test]
async fn a_relay_leaves_the_list_when_its_connection_stops() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 1024];
        let _ = socket.read(&mut request).await.unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        // The body never ends, as a device's video doesn't.
        std::future::pending::<()>().await;
    });
    let body = get(port, "/").await.unwrap();
    let streams = Arc::new(Mutex::new(Vec::new()));
    let (replies, _received) = mpsc::channel(8);
    let (send, outgoing) = mpsc::channel(8);
    let stopped = CancellationToken::new();
    let task = tokio::spawn(relay(
        Upstream::Body(body),
        outgoing,
        replies.clone(),
        stopped.clone(),
        "video:1".to_owned(),
        Listed {
            streams: Arc::clone(&streams),
            own: send.clone(),
        },
    ));
    streams.lock().unwrap().push(Relay {
        replies,
        id: "video:1".to_owned(),
        send,
        task: task.abort_handle(),
    });
    stopped.cancel();
    task.await.unwrap();
    assert!(streams.lock().unwrap().is_empty());
}
