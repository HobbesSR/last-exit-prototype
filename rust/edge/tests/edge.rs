//! The edge against a fake Node: a TCP link listener written here and a real WebTransport client.

use std::time::Duration;

use last_exit_edge::frame::link::{
    ACCEPT, CLOSE, CLOSED, DATAGRAM, DELIVER, EDGE, MESSAGE, OPEN, WRITTEN,
};
use last_exit_edge::frame::{self, Decoder};
use last_exit_edge::{Config, run};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use wtransport::config::ClientConfig;
use wtransport::endpoint::ConnectOptions;
use wtransport::error::ConnectionError;
use wtransport::tls::Sha256Digest;
use wtransport::{Connection, Endpoint, RecvStream, SendStream};

const MAX_BYTES: usize = 1000;
const HTTP_PORT: u16 = 3000;

/// The fake Node's end of the link.
struct Node {
    listener: TcpListener,
    stream: Option<TcpStream>,
    decoder: Decoder,
}

impl Node {
    async fn next(&mut self) -> (u8, Vec<u8>) {
        timeout(Duration::from_secs(5), async {
            loop {
                if let Some(frame) = self.decoder.next_frame().unwrap() {
                    return frame;
                }
                let mut chunk = [0u8; 4096];
                let read = self
                    .stream
                    .as_mut()
                    .unwrap()
                    .read(&mut chunk)
                    .await
                    .unwrap();
                assert!(read > 0, "link closed");
                self.decoder.push(&chunk[..read]);
            }
        })
        .await
        .expect("a link frame")
    }

    async fn send(&mut self, kind: u8, parts: &[&[u8]]) {
        self.stream
            .as_mut()
            .unwrap()
            .write_all(&frame::encode(kind, parts))
            .await
            .unwrap();
    }

    /// Accepts the edge's link, reads its EDGE and answers ACCEPT; returns the EDGE JSON.
    async fn handshake(&mut self) -> String {
        let (stream, _) = timeout(Duration::from_secs(5), self.listener.accept())
            .await
            .unwrap()
            .unwrap();
        self.stream = Some(stream);
        self.decoder = Decoder::new(1 << 20);
        let (kind, body) = self.next().await;
        assert_eq!(kind, EDGE);
        let accept =
            format!("{{\"link\":3,\"httpPort\":{HTTP_PORT},\"maxMessageBytes\":{MAX_BYTES}}}");
        self.send(ACCEPT, &[accept.as_bytes()]).await;
        String::from_utf8(body).unwrap()
    }
}

/// Starts an edge on any port against a fake Node, and returns both with the edge's port and hash.
async fn start(
    rotate_after: Duration,
) -> (Node, JoinHandle<Result<(), String>>, u16, Sha256Digest) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = Config::new(listener.local_addr().unwrap().to_string());
    config.port = 0;
    config.rotate_after = rotate_after;
    let edge = tokio::spawn(async move { run(config).await.map_err(|error| error.to_string()) });
    let mut node = Node {
        listener,
        stream: None,
        decoder: Decoder::new(0),
    };
    let json = node.handshake().await;
    let (port, hash) = parse_edge(&json);
    (node, edge, port, hash)
}

fn parse_edge(json: &str) -> (u16, Sha256Digest) {
    let after = |key: &str| &json[json.find(key).unwrap() + key.len()..];
    let port: String = after("\"port\":")
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    let hash: String = after("\"certificateHash\":\"")
        .chars()
        .take_while(|c| *c != '"')
        .collect();
    let bytes: Vec<u8> = (0..32)
        .map(|i| u8::from_str_radix(&hash[2 * i..2 * i + 2], 16).unwrap())
        .collect();
    (
        port.parse().unwrap(),
        Sha256Digest::new(bytes.try_into().unwrap()),
    )
}

async fn connect(
    port: u16,
    hash: &Sha256Digest,
    path: &str,
    origin: Option<&str>,
) -> Result<Connection, String> {
    let config = ClientConfig::builder()
        .with_bind_default()
        .with_server_certificate_hashes([hash.clone()])
        .build();
    let endpoint = Endpoint::client(config).unwrap();
    let mut options = ConnectOptions::builder(format!("https://127.0.0.1:{port}{path}"));
    if let Some(origin) = origin {
        options = options.add_header("origin", origin);
    }
    let connection = timeout(Duration::from_secs(5), endpoint.connect(options.build()))
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|error| error.to_string())?;
    // Keep the endpoint alive as long as the connection by leaking it; tests are short.
    std::mem::forget(endpoint);
    Ok(connection)
}

/// Opens the stream and sends one frame so the edge sees it, as a browser's first message would.
async fn open_stream(connection: &Connection, first: &[u8]) -> (SendStream, RecvStream) {
    let (mut send, recv) = connection.open_bi().await.unwrap().await.unwrap();
    send.write_all(first).await.unwrap();
    (send, recv)
}

async fn read_frame(recv: &mut RecvStream) -> (u8, Vec<u8>) {
    let mut decoder = Decoder::new(1 << 20);
    timeout(Duration::from_secs(5), async {
        loop {
            if let Some(frame) = decoder.next_frame().unwrap() {
                return frame;
            }
            let mut chunk = [0u8; 4096];
            let read = recv.read(&mut chunk).await.unwrap().expect("stream ended");
            decoder.push(&chunk[..read]);
        }
    })
    .await
    .expect("a stream frame")
}

async fn closed_with(connection: &Connection) -> (u64, Vec<u8>) {
    match timeout(Duration::from_secs(5), connection.closed())
        .await
        .expect("a close")
    {
        ConnectionError::ApplicationClosed(close) => {
            (close.code().into_inner(), close.reason().to_vec())
        }
        other => panic!("not an application close: {other:?}"),
    }
}

#[tokio::test]
async fn carries_messages_both_ways_and_closes_with_the_code() {
    let (mut node, _edge, port, hash) = start(Duration::from_secs(3600)).await;
    let connection = connect(port, &hash, "/arena", Some("http://127.0.0.1:3000"))
        .await
        .unwrap();
    let (mut send, mut recv) =
        open_stream(&connection, &frame::encode(frame::TEXT, &[b"hi"])).await;

    let (kind, body) = node.next().await;
    assert_eq!((kind, body.len()), (OPEN, 4));
    let session = body.clone();
    let (kind, body) = node.next().await;
    assert_eq!(kind, MESSAGE);
    assert_eq!(body, [&session[..], &[frame::TEXT], b"hi"].concat());

    send.write_all(&frame::encode(frame::BINARY, &[&[1, 2, 3]]))
        .await
        .unwrap();
    let (_, body) = node.next().await;
    assert_eq!(body, [&session[..], &[frame::BINARY], &[1, 2, 3]].concat());

    node.send(DELIVER, &[&session, &[frame::BINARY], b"abcde"])
        .await;
    assert_eq!(
        read_frame(&mut recv).await,
        (frame::BINARY, b"abcde".to_vec())
    );
    let (kind, body) = node.next().await;
    assert_eq!(kind, WRITTEN);
    assert_eq!(body, [&session[..], &5u64.to_be_bytes()].concat());
    node.send(DELIVER, &[&session, &[frame::TEXT], b"xyz"])
        .await;
    assert_eq!(read_frame(&mut recv).await, (frame::TEXT, b"xyz".to_vec()));
    let (_, body) = node.next().await;
    assert_eq!(body, [&session[..], &8u64.to_be_bytes()].concat());

    node.send(CLOSE, &[&session, &1000u16.to_be_bytes(), b"bye"])
        .await;
    assert_eq!(closed_with(&connection).await, (1000, b"bye".to_vec()));
    let (kind, body) = node.next().await;
    assert_eq!((kind, body), (CLOSED, session));
}

#[tokio::test]
async fn forwards_datagrams_unparsed_and_drops_empty_or_oversize_ones() {
    let (mut node, _edge, port, hash) = start(Duration::from_secs(3600)).await;
    let connection = connect(port, &hash, "/arena", None).await.unwrap();
    let (_send, _recv) = open_stream(&connection, &frame::encode(frame::TEXT, &[b"hi"])).await;
    let (kind, session) = node.next().await;
    assert_eq!(kind, OPEN);
    assert_eq!(node.next().await.0, MESSAGE);

    connection.send_datagram(b"[1]").unwrap();
    assert_eq!(
        node.next().await,
        (DATAGRAM, [&session[..], b"[1]"].concat())
    );
    // Over the limit, or empty, is dropped, as a lost datagram would be; the session stays open and the next one passes.
    connection.send_datagram(vec![b'x'; MAX_BYTES + 1]).unwrap();
    connection.send_datagram(b"").unwrap();
    connection.send_datagram(b"[2]").unwrap();
    assert_eq!(
        node.next().await,
        (DATAGRAM, [&session[..], b"[2]"].concat())
    );
}

#[tokio::test]
async fn a_client_frame_at_the_limit_passes_and_one_over_closes_with_1008() {
    let (mut node, _edge, port, hash) = start(Duration::from_secs(3600)).await;
    let connection = connect(port, &hash, "/arena", None).await.unwrap();
    let mut bytes = frame::encode(frame::TEXT, &[&vec![b'x'; MAX_BYTES]]);
    bytes.extend(frame::encode(frame::TEXT, &[&vec![b'x'; MAX_BYTES + 1]]));
    let (_send, _recv) = open_stream(&connection, &bytes).await;
    let (kind, session) = node.next().await;
    assert_eq!(kind, OPEN);
    assert_eq!(
        node.next().await.0,
        MESSAGE,
        "a payload of exactly the limit is forwarded"
    );
    assert_eq!(
        closed_with(&connection).await,
        (1008, b"message too large".to_vec())
    );
    assert_eq!(node.next().await, (CLOSED, session));
}

#[tokio::test]
async fn an_unknown_flag_closes_with_1008_as_a_bad_frame() {
    let (mut node, _edge, port, hash) = start(Duration::from_secs(3600)).await;
    let connection = connect(port, &hash, "/arena", None).await.unwrap();
    let (_send, _recv) = open_stream(&connection, &frame::encode(2, &[b"x"])).await;
    let (kind, session) = node.next().await;
    assert_eq!(kind, OPEN);
    assert_eq!(
        closed_with(&connection).await,
        (1008, b"bad frame".to_vec())
    );
    assert_eq!(node.next().await, (CLOSED, session));
}

#[tokio::test]
async fn refuses_a_wrong_path_or_origin_and_allows_the_right_one() {
    let (_node, _edge, port, hash) = start(Duration::from_secs(3600)).await;
    assert!(connect(port, &hash, "/other", None).await.is_err());
    assert!(
        connect(port, &hash, "/arena", Some("http://127.0.0.1:3001"))
            .await
            .is_err()
    );
    assert!(
        connect(port, &hash, "/arena", Some("http://evil.test:3000"))
            .await
            .is_err()
    );
    assert!(
        connect(port, &hash, "/arena", Some("http://127.0.0.1:3000"))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn a_dropped_link_closes_sessions_and_the_edge_reconnects() {
    let (mut node, _edge, port, hash) = start(Duration::from_secs(3600)).await;
    let connection = connect(port, &hash, "/arena", None).await.unwrap();
    let _stream = open_stream(&connection, &frame::encode(frame::TEXT, &[b"hi"])).await;
    assert_eq!(node.next().await.0, OPEN);
    node.stream = None;
    assert_eq!(closed_with(&connection).await.0, 1001);
    // The edge dials again after the first link's socket was dropped above.
    let json = node.handshake().await;
    assert_eq!(parse_edge(&json).0, port);
}

#[tokio::test]
async fn rotates_the_certificate_and_says_so() {
    let (mut node, _edge, _port, hash) = start(Duration::from_millis(300)).await;
    let (kind, body) = node.next().await;
    assert_eq!(kind, EDGE);
    let (_, rotated) = parse_edge(std::str::from_utf8(&body).unwrap());
    assert_ne!(rotated, hash);
}

#[tokio::test]
async fn another_link_version_is_fatal() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = Config::new(listener.local_addr().unwrap().to_string());
    config.port = 0;
    let edge = tokio::spawn(async move { run(config).await.map_err(|error| error.to_string()) });
    let (mut stream, _) = listener.accept().await.unwrap();
    stream
        .write_all(&frame::encode(
            ACCEPT,
            &[br#"{"link":1,"httpPort":1,"maxMessageBytes":1}"#],
        ))
        .await
        .unwrap();
    let result = timeout(Duration::from_secs(5), edge)
        .await
        .unwrap()
        .unwrap();
    assert!(result.is_err());
}
