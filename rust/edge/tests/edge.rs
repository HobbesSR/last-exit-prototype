//! The edge against a fake Node: a TCP link listener written here and real WebTransport and WebSocket clients.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use last_exit_edge::frame::link::{
    ACCEPT, CLOSE, CLOSED, DATAGRAM, DELIVER, EDGE, MESSAGE, OPEN, SEND, WRITTEN,
};
use last_exit_edge::frame::{self, Decoder};
use last_exit_edge::{Config, run};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, pem::PemObject};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use wtransport::config::ClientConfig;
use wtransport::endpoint::ConnectOptions;
use wtransport::error::ConnectionError;
use wtransport::tls::Sha256Digest;
use wtransport::{Connection, Endpoint, Identity, RecvStream, SendStream};

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
            format!("{{\"link\":5,\"httpPort\":{HTTP_PORT},\"maxMessageBytes\":{MAX_BYTES}}}");
        self.send(ACCEPT, &[accept.as_bytes()]).await;
        String::from_utf8(body).unwrap()
    }
}

/// Starts an edge on any ports against a fake Node, and returns both with the edge's WT port, WS port, and hash.
async fn start_with(
    rotate_after: Duration,
    identity: Option<(std::path::PathBuf, std::path::PathBuf)>,
) -> (
    Node,
    JoinHandle<Result<(), String>>,
    u16,
    u16,
    Option<Sha256Digest>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = Config::new(listener.local_addr().unwrap().to_string());
    config.port = 0;
    config.ws_port = 0;
    config.identity = identity;
    config.rotate_after = rotate_after;
    let edge = tokio::spawn(async move { run(config).await.map_err(|error| error.to_string()) });
    let mut node = Node {
        listener,
        stream: None,
        decoder: Decoder::new(0),
    };
    let json = node.handshake().await;
    let (port, ws_port, ws_tls, hash) = parse_edge(&json);
    assert_eq!(ws_tls, hash.is_none());
    (node, edge, port, ws_port, hash)
}

async fn start(
    rotate_after: Duration,
) -> (Node, JoinHandle<Result<(), String>>, u16, Sha256Digest) {
    let (node, edge, port, _ws_port, hash) = start_with(rotate_after, None).await;
    (node, edge, port, hash.unwrap())
}

fn parse_edge(json: &str) -> (u16, u16, bool, Option<Sha256Digest>) {
    let after = |key: &str| &json[json.find(key).unwrap() + key.len()..];
    let port: String = after("\"port\":")
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    let ws_port: String = after("\"wsPort\":")
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    let ws_tls = after("\"wsTls\":").starts_with("true");
    let hash_rest = after("\"certificateHash\":");
    let hash = if let Some(quoted) = hash_rest.strip_prefix('"') {
        let hex: String = quoted.chars().take_while(|c| *c != '"').collect();
        let bytes: Vec<u8> = (0..32)
            .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap())
            .collect();
        Some(Sha256Digest::new(bytes.try_into().unwrap()))
    } else {
        assert!(hash_rest.starts_with("null"));
        None
    };
    (
        port.parse().unwrap(),
        ws_port.parse().unwrap(),
        ws_tls,
        hash,
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
    assert_eq!((kind, body.len()), (OPEN, 5));
    assert_eq!(body[4], frame::DATAGRAMS);
    let session = body[..4].to_vec();
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
    let (kind, open_body) = node.next().await;
    assert_eq!(kind, OPEN);
    let session = open_body[..4].to_vec();
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
async fn sends_datagrams_as_numbered_fragments_and_drops_oversize_messages() {
    use frame::datagram::{FRAGMENT_BYTES, HEADER, MAX_MESSAGE};
    let (mut node, _edge, port, hash) = start(Duration::from_secs(3600)).await;
    let connection = connect(port, &hash, "/arena", None).await.unwrap();
    let (_send, _recv) = open_stream(&connection, &frame::encode(frame::TEXT, &[b"hi"])).await;
    let (kind, open_body) = node.next().await;
    assert_eq!(kind, OPEN);
    let session = open_body[..4].to_vec();
    assert_eq!(node.next().await.0, MESSAGE);
    let max = connection.max_datagram_size().expect("datagrams supported");
    println!("client max_datagram_size on loopback: {max}");
    assert!(max >= HEADER + FRAGMENT_BYTES);

    let receive = |connection: Connection| async move {
        timeout(Duration::from_secs(5), connection.receive_datagram())
            .await
            .expect("a datagram")
            .unwrap()
            .payload()
            .to_vec()
    };

    // (a) A small message is one fragment, number 0.
    node.send(SEND, &[&session[..], b"0123456789"]).await;
    assert_eq!(
        receive(connection.clone()).await,
        [&[0u8, 0, 0, 1][..], b"0123456789"].concat()
    );

    // (b) The largest message is four fragments, number 1, reassembled by index.
    let message: Vec<u8> = (0..MAX_MESSAGE).map(|i| (i % 251) as u8).collect();
    node.send(SEND, &[&session[..], &message]).await;
    let mut parts: Vec<Option<Vec<u8>>> = vec![None; 4];
    for _ in 0..4 {
        let datagram = receive(connection.clone()).await;
        assert!(datagram.len() <= HEADER + FRAGMENT_BYTES);
        assert_eq!((datagram[0], datagram[1], datagram[3]), (0, 1, 4));
        parts[datagram[2] as usize] = Some(datagram[HEADER..].to_vec());
    }
    let joined: Vec<u8> = parts.into_iter().flat_map(|part| part.unwrap()).collect();
    assert_eq!(joined, message);

    // (c) An oversize message is not sent. It still takes number 2, so the next message is number 3 and the
    // gap shows the client one was refused.
    node.send(SEND, &[&session[..], &vec![7u8; MAX_MESSAGE + 1]])
        .await;
    node.send(SEND, &[&session[..], b"after"]).await;
    assert_eq!(
        receive(connection.clone()).await,
        [&[0u8, 3, 0, 1][..], b"after"].concat()
    );
}

#[tokio::test]
async fn a_client_frame_at_the_limit_passes_and_one_over_closes_with_1008() {
    let (mut node, _edge, port, hash) = start(Duration::from_secs(3600)).await;
    let connection = connect(port, &hash, "/arena", None).await.unwrap();
    let mut bytes = frame::encode(frame::TEXT, &[&vec![b'x'; MAX_BYTES]]);
    bytes.extend(frame::encode(frame::TEXT, &[&vec![b'x'; MAX_BYTES + 1]]));
    let (_send, _recv) = open_stream(&connection, &bytes).await;
    let (kind, open_body) = node.next().await;
    assert_eq!(kind, OPEN);
    let session = open_body[..4].to_vec();
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
    let (kind, open_body) = node.next().await;
    assert_eq!(kind, OPEN);
    let session = open_body[..4].to_vec();
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
    let (_, _, _, rotated) = parse_edge(std::str::from_utf8(&body).unwrap());
    assert_ne!(rotated.unwrap(), hash);
}

#[tokio::test]
async fn another_link_version_is_fatal() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = Config::new(listener.local_addr().unwrap().to_string());
    config.port = 0;
    config.ws_port = 0;
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

async fn ws_connect(
    ws_port: u16,
    path: &str,
    origin: Option<&str>,
) -> Result<WebSocketStream<TcpStream>, String> {
    let tcp = TcpStream::connect(("127.0.0.1", ws_port))
        .await
        .map_err(|e| e.to_string())?;
    let mut req = format!("ws://127.0.0.1:{ws_port}{path}")
        .into_client_request()
        .unwrap();
    if let Some(origin) = origin {
        req.headers_mut().insert("origin", origin.parse().unwrap());
    }
    let (ws, _) = timeout(
        Duration::from_secs(5),
        tokio_tungstenite::client_async(req, tcp),
    )
    .await
    .map_err(|_| "timed out".to_string())?
    .map_err(|e| e.to_string())?;
    Ok(ws)
}

#[tokio::test]
async fn websocket_carries_messages_checks_origin_and_enforces_limits() {
    let (mut node, _edge, _port, ws_port, _hash) =
        start_with(Duration::from_secs(3600), None).await;
    assert!(ws_connect(ws_port, "/other", None).await.is_err());
    assert!(
        ws_connect(ws_port, "/arena", Some("http://127.0.0.1:3001"))
            .await
            .is_err()
    );
    assert!(
        ws_connect(ws_port, "/arena", Some("http://evil.test:3000"))
            .await
            .is_err()
    );

    let ws = ws_connect(ws_port, "/arena", Some("http://127.0.0.1:3000"))
        .await
        .unwrap();
    let (kind, body) = node.next().await;
    assert_eq!((kind, body.len()), (OPEN, 5));
    assert_eq!(body[4], frame::STREAM_ONLY);
    let session = body[..4].to_vec();

    let (mut sink, mut stream) = ws.split();
    sink.send(Message::Text("hi".into())).await.unwrap();
    assert_eq!(
        node.next().await,
        (MESSAGE, [&session[..], &[frame::TEXT], b"hi"].concat())
    );

    node.send(DELIVER, &[&session, &[frame::BINARY], b"abcde"])
        .await;
    let msg = timeout(Duration::from_secs(5), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(msg, Message::Binary(b"abcde".to_vec().into()));
    assert_eq!(
        node.next().await,
        (WRITTEN, [&session[..], &5u64.to_be_bytes()].concat())
    );

    // Oversize WebSocket message closes with 1008.
    sink.send(Message::Text("x".repeat(MAX_BYTES + 1).into()))
        .await
        .unwrap();
    let close = loop {
        match timeout(Duration::from_secs(5), stream.next())
            .await
            .unwrap()
        {
            Some(Ok(Message::Close(frame))) => break frame.unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("expected close frame, got {other:?}"),
        }
    };
    assert_eq!(close.code, CloseCode::Policy);
    assert_eq!(node.next().await, (CLOSED, session));

    // Client-initiated close on an idle session completes the close handshake cleanly.
    let ws_client_close = ws_connect(ws_port, "/arena", None).await.unwrap();
    let (kind_cc, body_cc) = node.next().await;
    assert_eq!((kind_cc, body_cc.len()), (OPEN, 5));
    let session_cc = body_cc[..4].to_vec();
    let (mut sink_cc, mut stream_cc) = ws_client_close.split();
    sink_cc
        .send(Message::Close(Some(CloseFrame {
            code: CloseCode::Normal,
            reason: "client bye".into(),
        })))
        .await
        .unwrap();
    let reply_cc = loop {
        match timeout(Duration::from_secs(5), stream_cc.next())
            .await
            .unwrap()
        {
            Some(Ok(Message::Close(frame))) => break frame.unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("expected close reply frame, got {other:?}"),
        }
    };
    assert_eq!(reply_cc.code, CloseCode::Normal);
    assert_eq!(node.next().await, (CLOSED, session_cc));

    // Node-initiated close drains earlier DELIVER payloads then sends the close frame.
    let ws_node_close = ws_connect(ws_port, "/arena", None).await.unwrap();
    let session_nc = node.next().await.1[..4].to_vec();
    let (_sink_nc, mut stream_nc) = ws_node_close.split();
    node.send(DELIVER, &[&session_nc, &[frame::TEXT], b"last"])
        .await;
    node.send(CLOSE, &[&session_nc, &1000u16.to_be_bytes(), b"done"])
        .await;
    let first_nc = timeout(Duration::from_secs(5), stream_nc.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(first_nc, Message::Text("last".into()));
    let close_nc = loop {
        match timeout(Duration::from_secs(5), stream_nc.next())
            .await
            .unwrap()
        {
            Some(Ok(Message::Close(frame))) => break frame.unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("expected node close frame, got {other:?}"),
        }
    };
    assert_eq!(close_nc.code, CloseCode::Normal);
    assert_eq!(close_nc.reason.as_str(), "done");
    assert_eq!(
        node.next().await,
        (WRITTEN, [&session_nc[..], &4u64.to_be_bytes()].concat())
    );
    assert_eq!(node.next().await, (CLOSED, session_nc));

    // Stalled reader: Node CLOSE starts FLUSH_WAIT even while queued DELIVERs are backed up, then drops and reports CLOSED.
    let sock_stalled = tokio::net::TcpSocket::new_v4().unwrap();
    sock_stalled.set_recv_buffer_size(4096).unwrap();
    let tcp_stalled = sock_stalled
        .connect(std::net::SocketAddr::from(([127, 0, 0, 1], ws_port)))
        .await
        .unwrap();
    let req_stalled = format!("ws://127.0.0.1:{ws_port}/arena")
        .into_client_request()
        .unwrap();
    let (_ws_stalled, _) = timeout(
        Duration::from_secs(5),
        tokio_tungstenite::client_async(req_stalled, tcp_stalled),
    )
    .await
    .unwrap()
    .unwrap();
    let session_stalled = node.next().await.1[..4].to_vec();
    let bulk = vec![0x7au8; MAX_BYTES];
    for _ in 0..512 {
        node.send(DELIVER, &[&session_stalled, &[frame::BINARY], &bulk])
            .await;
    }
    node.send(CLOSE, &[&session_stalled, &1000u16.to_be_bytes(), b"bye"])
        .await;
    timeout(Duration::from_secs(4), async {
        loop {
            let (kind, body) = node.next().await;
            if kind == WRITTEN {
                continue;
            }
            assert_eq!((kind, body), (CLOSED, session_stalled));
            break;
        }
    })
    .await
    .unwrap();

    // Link drop closes open WebSocket sessions with 1001 even when deliveries are in flight.
    let ws2 = ws_connect(ws_port, "/arena", None).await.unwrap();
    let session2 = node.next().await.1[..4].to_vec();
    let (_sink2, mut stream2) = ws2.split();
    node.send(DELIVER, &[&session2, &[frame::BINARY], &vec![0x5a; 4096]])
        .await;
    node.send(DELIVER, &[&session2, &[frame::BINARY], &vec![0x5b; 4096]])
        .await;
    node.stream = None;
    let close2 = loop {
        match timeout(Duration::from_secs(5), stream2.next())
            .await
            .unwrap()
        {
            Some(Ok(Message::Close(frame))) => break frame.unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("expected close frame, got {other:?}"),
        }
    };
    assert_eq!(close2.code, CloseCode::from(1001));
    assert_eq!(close2.reason.as_str(), "link lost");
}

#[tokio::test]
async fn wss_uses_the_configured_pem_identity() {
    let dir = std::env::temp_dir().join(format!("last-exit-edge-wss-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");
    let identity = Identity::self_signed(["localhost", "127.0.0.1"]).unwrap();
    identity
        .certificate_chain()
        .store_pemfile(&cert_path)
        .await
        .unwrap();
    identity
        .private_key()
        .store_secret_pemfile(&key_path)
        .await
        .unwrap();

    let (mut node, _edge, _port, ws_port, _hash) = start_with(
        Duration::from_secs(3600),
        Some((cert_path.clone(), key_path.clone())),
    )
    .await;

    let mut roots = rustls::RootCertStore::empty();
    for cert in CertificateDer::pem_file_iter(&cert_path).unwrap() {
        roots.add(cert.unwrap()).unwrap();
    }
    let tls_config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(tls_config));
    let tcp = TcpStream::connect(("127.0.0.1", ws_port)).await.unwrap();
    let tls = connector
        .connect(ServerName::try_from("localhost").unwrap(), tcp)
        .await
        .unwrap();
    let req = format!("wss://localhost:{ws_port}/arena")
        .into_client_request()
        .unwrap();
    let (ws, _) = tokio_tungstenite::client_async(req, tls).await.unwrap();

    let (kind, body) = node.next().await;
    assert_eq!((kind, body.len()), (OPEN, 5));
    assert_eq!(body[4], frame::STREAM_ONLY);
    let session = body[..4].to_vec();

    let (mut sink, mut stream) = ws.split();
    sink.send(Message::Text("secure".into())).await.unwrap();
    assert_eq!(
        node.next().await,
        (MESSAGE, [&session[..], &[frame::TEXT], b"secure"].concat())
    );
    node.send(CLOSE, &[&session, &1000u16.to_be_bytes(), b"done"])
        .await;
    let close = loop {
        match timeout(Duration::from_secs(5), stream.next())
            .await
            .unwrap()
        {
            Some(Ok(Message::Close(frame))) => break frame.unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("expected close frame, got {other:?}"),
        }
    };
    assert_eq!(
        close,
        CloseFrame {
            code: CloseCode::Normal,
            reason: "done".into()
        }
    );
    assert_eq!(node.next().await, (CLOSED, session));
    let _ = std::fs::remove_dir_all(&dir);
}
