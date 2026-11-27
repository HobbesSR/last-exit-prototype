//! The network edge (#1095, #1207, docs/24.5, docs/27). It terminates WebTransport and WebSocket and forwards
//! each session to Node over one framed TCP link, as "Stage 1's contracts" through "Stage 4" in 24.5 specify,
//! and sends Node's SEND frames to WebTransport clients as datagram fragments ("Stage 3's contracts").

pub mod frame;
pub mod origin;

use std::collections::HashMap;
use std::error::Error;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use wtransport::endpoint::endpoint_side::Server;
use wtransport::endpoint::{IncomingSession, SessionRequest};
use wtransport::quinn::TransportConfig;
use wtransport::{Connection, Endpoint, Identity, RecvStream, SendStream, ServerConfig, VarInt};

use frame::link::{ACCEPT, CLOSE, CLOSED, DATAGRAM, DELIVER, EDGE, MESSAGE, OPEN, SEND, WRITTEN};

/// The link protocol version this edge speaks.
const LINK_VERSION: u64 = 5;
/// The only session path.
const ARENA_PATH: &str = "/arena";
/// QUIC's cap on unacknowledged bytes per connection, so a write completes only when the client keeps up.
const SEND_WINDOW: u64 = 256 * 1024;
/// How long a session may stay without opening its stream.
const STREAM_WAIT: Duration = Duration::from_secs(10);
/// How long a closing session may take to flush what Node delivered before it.
const FLUSH_WAIT: Duration = Duration::from_secs(2);
/// A self-signed certificate lives under the browsers' 14 day cap.
const CERT_DAYS: u32 = 13;
/// The largest link frame body accepted from Node.
const LINK_MAX_BODY: usize = 32 << 20;
/// WebSocket close codes the edge uses on its own.
const CLOSE_NORMAL: u16 = 1000;
const CLOSE_GOING_AWAY: u16 = 1001;
const CLOSE_POLICY: u16 = 1008;

/// What the edge is told on its command line.
#[derive(Clone, Debug)]
pub struct Config {
    /// Node's link address, `HOST:PORT`.
    pub link: String,
    /// The IP address to bind WebTransport and WebSocket listeners on; defaults to loopback `127.0.0.1`.
    pub bind: IpAddr,
    /// The UDP port to bind for WebTransport; 0 picks any.
    pub port: u16,
    /// The TCP port to bind for WebSocket; 0 picks any.
    pub ws_port: u16,
    /// A CA-issued certificate and key (PEM); `None` makes self-signed ones for WebTransport and serves plain `ws://`.
    pub identity: Option<(PathBuf, PathBuf)>,
    /// How long a self-signed certificate is used before it is replaced.
    pub rotate_after: Duration,
}

impl Config {
    /// The defaults: loopback bind `127.0.0.1`, UDP port 4433, TCP WebSocket port 4434, self-signed certificate rotated after 10 days.
    pub fn new(link: impl Into<String>) -> Self {
        Config {
            link: link.into(),
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 4433,
            ws_port: 4434,
            identity: None,
            rotate_after: Duration::from_secs(10 * 24 * 3600),
        }
    }
}

/// What Node's ACCEPT frame sets.
struct Params {
    http_port: u16,
    max_message_bytes: usize,
}

/// A message from Node to one session.
enum Down {
    Deliver(u8, Vec<u8>),
    Close(u16, Vec<u8>),
}

/// What the link keeps for one session: the queue to its writer, and for WebTransport its connection so
/// datagrams can be sent without waiting behind stream writes.
struct Session {
    tx: mpsc::UnboundedSender<Down>,
    close_requested: watch::Sender<Option<tokio::time::Instant>>,
    datagrams: Option<(Connection, AtomicU16)>,
}

/// One live link to Node: its outgoing frames and the sessions it carries.
struct Link {
    out: mpsc::Sender<Vec<u8>>,
    params: OnceLock<Params>,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
    down: watch::Sender<bool>,
}

impl Link {
    /// Queues a frame for Node; false when the link is gone.
    async fn send(&self, frame: Vec<u8>) -> bool {
        self.out.send(frame).await.is_ok()
    }
}

/// The certificate in use and the current link, kept together so a rotation and a connect never miss each other.
struct State {
    hash: Option<String>,
    valid_until: u64,
    link: Option<Arc<Link>>,
}

struct Shared {
    bind: IpAddr,
    port: u16,
    ws_port: u16,
    ws_tls: bool,
    state: Mutex<State>,
}

impl Shared {
    /// The link, once Node has accepted it.
    fn accepted(&self) -> Option<Arc<Link>> {
        let link = self.state.lock().unwrap().link.clone()?;
        link.params.get().is_some().then_some(link)
    }

    /// The EDGE frame for the certificate and ports now in use.
    fn edge_frame(&self, state: &State) -> Vec<u8> {
        let hash = match &state.hash {
            Some(hash) => format!("\"{hash}\""),
            None => "null".to_string(),
        };
        let json = format!(
            "{{\"link\":{LINK_VERSION},\"port\":{},\"wsPort\":{},\"wsTls\":{},\"certificateHash\":{hash},\"validUntil\":{}}}",
            self.port, self.ws_port, self.ws_tls, state.valid_until
        );
        frame::encode(EDGE, &[json.as_bytes()])
    }
}

type BoxError = Box<dyn Error + Send + Sync>;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A self-signed identity valid for under 14 days, with its hash and expiry.
fn self_signed() -> Result<(Identity, String, u64), BoxError> {
    let valid_until = now_ms() + CERT_DAYS as u64 * 24 * 3600 * 1000;
    let identity = Identity::self_signed_builder()
        .subject_alt_names(["localhost", "127.0.0.1", "::1"])
        .from_now_utc()
        .validity_days(CERT_DAYS)
        .build()?;
    let hash = hex(identity.certificate_chain().as_slice()[0].hash().as_ref());
    Ok((identity, hash, valid_until))
}

fn server_config(identity: Identity, bind: IpAddr, port: u16) -> Result<ServerConfig, BoxError> {
    let mut config = ServerConfig::builder()
        .with_bind_address(SocketAddr::new(bind, port))
        .with_identity(identity)
        .keep_alive_interval(Some(Duration::from_secs(3)))
        .build();
    let mut transport = TransportConfig::default();
    transport.send_window(SEND_WINDOW);
    transport.keep_alive_interval(Some(Duration::from_secs(3)));
    config
        .quic_config_mut()
        .transport_config(Arc::new(transport));
    Ok(config)
}

/// Reads the unsigned integer under `key` in a flat JSON object.
fn json_u64(json: &str, key: &str) -> Option<u64> {
    let pattern = format!("\"{key}\"");
    let rest = json[json.find(&pattern)? + pattern.len()..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn ws_tls_acceptor(cert: &Path, key: &Path) -> Result<TlsAcceptor, BoxError> {
    let certs: Vec<CertificateDer<'static>> =
        CertificateDer::pem_file_iter(cert)?.collect::<Result<Vec<_>, _>>()?;
    let key = PrivateKeyDer::from_pem_file(key)?;
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_single_cert(certs, key)?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Runs the edge: binds the WebTransport and WebSocket endpoints, serves sessions, and keeps the link to Node up.
/// Returns only on a fatal error: the bind or certificate failing, or Node speaking another link version.
pub async fn run(config: Config) -> Result<(), BoxError> {
    let (identity, hash, valid_until, ws_tls) = match &config.identity {
        Some((cert, key)) => (
            Identity::load_pemfiles(cert, key).await?,
            None,
            0,
            Some(ws_tls_acceptor(cert, key)?),
        ),
        None => {
            let (identity, hash, valid_until) = self_signed()?;
            (identity, Some(hash), valid_until, None)
        }
    };
    let endpoint = Endpoint::server(server_config(identity, config.bind, config.port)?)?;
    let port = endpoint.local_addr()?.port();
    let ws_listener = TcpListener::bind(SocketAddr::new(config.bind, config.ws_port)).await?;
    let ws_port = ws_listener.local_addr()?.port();
    println!(
        "last-exit-edge: {} UDP port {port}, WS port {ws_port}, link {}",
        config.bind, config.link
    );
    let shared = Arc::new(Shared {
        bind: config.bind,
        port,
        ws_port,
        ws_tls: ws_tls.is_some(),
        state: Mutex::new(State {
            hash,
            valid_until,
            link: None,
        }),
    });
    let endpoint = Arc::new(endpoint);

    if config.identity.is_none() {
        tokio::spawn(rotate(
            shared.clone(),
            endpoint.clone(),
            config.rotate_after,
        ));
    }
    tokio::spawn(accept_sessions(shared.clone(), endpoint));
    tokio::spawn(accept_ws_sessions(shared.clone(), ws_listener, ws_tls));

    loop {
        if let Ok(stream) = TcpStream::connect(&config.link).await
            && let Err(message) = serve_link(&shared, stream).await
        {
            return Err(message.into());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Replaces the self-signed certificate on a schedule and tells Node.
async fn rotate(shared: Arc<Shared>, endpoint: Arc<Endpoint<Server>>, every: Duration) {
    loop {
        tokio::time::sleep(every).await;
        let Ok((identity, hash, valid_until)) = self_signed() else {
            continue;
        };
        let Ok(config) = server_config(identity, shared.bind, shared.port) else {
            continue;
        };
        if endpoint.reload_config(config, false).is_err() {
            continue;
        }
        let (link, frame) = {
            let mut state = shared.state.lock().unwrap();
            state.hash = Some(hash);
            state.valid_until = valid_until;
            (state.link.clone(), shared.edge_frame(&state))
        };
        if let Some(link) = link {
            link.send(frame).await;
        }
    }
}

/// Serves one link until it drops. `Err` is fatal (a link version Node does not share); a dropped link is `Ok`.
async fn serve_link(shared: &Arc<Shared>, stream: TcpStream) -> Result<(), String> {
    let _ = stream.set_nodelay(true);
    let (mut reader, mut writer) = stream.into_split();
    let (out, mut queue) = mpsc::channel::<Vec<u8>>(1024);
    let (down, _) = watch::channel(false);
    let link = Arc::new(Link {
        out,
        params: OnceLock::new(),
        sessions: Mutex::new(HashMap::new()),
        next_id: AtomicU32::new(1),
        down,
    });
    let write_task = tokio::spawn(async move {
        while let Some(frame) = queue.recv().await {
            if writer.write_all(&frame).await.is_err() {
                break;
            }
        }
    });
    {
        let mut state = shared.state.lock().unwrap();
        let _ = link.out.try_send(shared.edge_frame(&state));
        state.link = Some(link.clone());
    }

    let result = read_link(&link, &mut reader).await;

    shared.state.lock().unwrap().link = None;
    let _ = link.down.send(true);
    link.sessions.lock().unwrap().clear();
    write_task.abort();
    result
}

/// Reads Node's frames: ACCEPT first, then DELIVER and CLOSE for sessions.
async fn read_link(
    link: &Arc<Link>,
    reader: &mut tokio::net::tcp::OwnedReadHalf,
) -> Result<(), String> {
    let mut decoder = frame::Decoder::new(LINK_MAX_BODY);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => return Ok(()),
            Ok(read) => read,
        };
        decoder.push(&chunk[..read]);
        loop {
            let (kind, body) = match decoder.next_frame() {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(_) => return Ok(()),
            };
            match kind {
                ACCEPT => {
                    let json = String::from_utf8_lossy(&body);
                    if json_u64(&json, "link") != Some(LINK_VERSION) {
                        return Err(format!("Node's link version is not {LINK_VERSION}: {json}"));
                    }
                    let (Some(http_port), Some(max)) = (
                        json_u64(&json, "httpPort"),
                        json_u64(&json, "maxMessageBytes"),
                    ) else {
                        return Ok(());
                    };
                    let params = Params {
                        http_port: http_port.min(u16::MAX as u64) as u16,
                        max_message_bytes: max as usize,
                    };
                    let _ = link.params.set(params);
                }
                // Nothing else is meaningful before ACCEPT.
                _ if link.params.get().is_none() => return Ok(()),
                DELIVER if body.len() >= 5 => {
                    let id = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                    let session = link.sessions.lock().unwrap().get(&id).cloned();
                    if let Some(session) = session {
                        let _ = session.tx.send(Down::Deliver(body[4], body[5..].to_vec()));
                    }
                }
                CLOSE if body.len() >= 6 => {
                    let id = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                    let code = u16::from_be_bytes([body[4], body[5]]);
                    let session = link.sessions.lock().unwrap().get(&id).cloned();
                    if let Some(session) = session {
                        let _ = session.tx.send(Down::Close(code, body[6..].to_vec()));
                        let _ = session.close_requested.send_if_modified(|slot| {
                            if slot.is_some() {
                                return false;
                            }
                            *slot = Some(tokio::time::Instant::now());
                            true
                        });
                    }
                }
                SEND if body.len() >= 5 => {
                    let id = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                    let session = link.sessions.lock().unwrap().get(&id).cloned();
                    if let Some(session) = session
                        && let Some((connection, next_number)) = &session.datagrams
                    {
                        // Numbered even when refused, so a gap tells the client a message was not sent.
                        let number = next_number.fetch_add(1, Ordering::Relaxed);
                        // Empty or too long is dropped; a lost or unsupported datagram is dropped too.
                        if let Some(parts) = frame::datagram::fragments(number, &body[4..]) {
                            for part in parts {
                                let _ = connection.send_datagram(part);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

/// Takes each incoming QUIC connection to its own task.
async fn accept_sessions(shared: Arc<Shared>, endpoint: Arc<Endpoint<Server>>) {
    loop {
        let incoming = endpoint.accept().await;
        if shared.accepted().is_none() {
            incoming.refuse();
            continue;
        }
        tokio::spawn(handle_incoming(shared.clone(), incoming));
    }
}

/// Checks a session request, accepts it, and serves it.
async fn handle_incoming(shared: Arc<Shared>, incoming: IncomingSession) {
    let Ok(request) = incoming.await else {
        return;
    };
    let Some(link) = shared.accepted() else {
        return request.forbidden().await;
    };
    let Some(params) = link.params.get() else {
        return request.forbidden().await;
    };
    if request.path() != ARENA_PATH {
        return request.not_found().await;
    }
    if !origin::allowed(request.origin(), request.authority(), params.http_port) {
        return request.forbidden().await;
    }
    serve_session(&link, params.max_message_bytes, request).await;
}

/// How a session ended.
enum Outcome {
    /// Close it with a WebSocket code and reason.
    Close(u16, Vec<u8>),
    /// It is already gone.
    Gone,
}

/// Serves one session from its first stream to its close, and tells Node when it ends.
async fn serve_session(link: &Arc<Link>, max_bytes: usize, request: SessionRequest) {
    let Ok(connection) = request.accept().await else {
        return;
    };
    // Subscribed before the wait, so a link lost while the client is still opening its stream is seen.
    let mut down = link.down.subscribe();
    let stream = tokio::select! {
        stream = tokio::time::timeout(STREAM_WAIT, connection.accept_bi()) => stream,
        _ = down.wait_for(|down| *down) => {
            connection.close(VarInt::from_u32(CLOSE_GOING_AWAY as u32), b"link lost");
            return;
        }
    };
    let Ok(Ok((send, recv))) = stream else {
        connection.close(VarInt::from_u32(CLOSE_POLICY as u32), b"no stream");
        return;
    };
    let id = link.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::unbounded_channel();
    let (close_requested, _) = watch::channel(None);
    link.sessions.lock().unwrap().insert(
        id,
        Arc::new(Session {
            tx,
            close_requested,
            datagrams: Some((connection.clone(), AtomicU16::new(0))),
        }),
    );
    if !link
        .send(frame::encode(
            OPEN,
            &[&id.to_be_bytes(), &[frame::DATAGRAMS]],
        ))
        .await
    {
        link.sessions.lock().unwrap().remove(&id);
        connection.close(VarInt::from_u32(CLOSE_GOING_AWAY as u32), b"link lost");
        return;
    }

    let outcome = tokio::select! {
        outcome = read_loop(recv, link, id, max_bytes) => outcome,
        outcome = write_loop(send, rx, link, id) => outcome,
        outcome = datagram_loop(&connection, link, id, max_bytes) => outcome,
        _ = connection.closed() => Outcome::Gone,
        _ = down.wait_for(|down| *down) => Outcome::Close(CLOSE_GOING_AWAY, b"link lost".to_vec()),
    };
    finish(&connection, outcome);
    link.sessions.lock().unwrap().remove(&id);
    link.send(frame::encode(CLOSED, &[&id.to_be_bytes()])).await;
}

fn finish(connection: &Connection, outcome: Outcome) {
    if let Outcome::Close(code, reason) = outcome {
        connection.close(VarInt::from_u32(code as u32), &reason);
    }
}

/// Forwards the client's frames to Node as MESSAGE until the stream ends or a frame breaks the rules.
async fn read_loop(mut recv: RecvStream, link: &Link, id: u32, max_bytes: usize) -> Outcome {
    let mut decoder = frame::Decoder::new(max_bytes);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match recv.read(&mut chunk).await {
            Ok(Some(read)) => decoder.push(&chunk[..read]),
            Ok(None) => return Outcome::Close(CLOSE_NORMAL, Vec::new()),
            Err(_) => return Outcome::Gone,
        }
        loop {
            match decoder.next_frame() {
                Ok(Some((flag, payload))) => {
                    if flag > frame::BINARY {
                        return Outcome::Close(CLOSE_POLICY, b"bad frame".to_vec());
                    }
                    let message = frame::encode(MESSAGE, &[&id.to_be_bytes(), &[flag], &payload]);
                    if !link.send(message).await {
                        return Outcome::Gone;
                    }
                }
                Ok(None) => break,
                // Refused as soon as its header is seen, before its payload is read.
                Err(frame::FrameError::TooLarge) => {
                    return Outcome::Close(CLOSE_POLICY, b"message too large".to_vec());
                }
                Err(frame::FrameError::Empty) => {
                    return Outcome::Close(CLOSE_POLICY, b"bad frame".to_vec());
                }
            }
        }
    }
}

/// Forwards the client's datagrams to Node as DATAGRAM, unparsed (docs/24.5 "Stage 2's contracts"). One longer
/// than the message limit is dropped, as a lost one would be: a datagram carries no promise of arrival.
async fn datagram_loop(connection: &Connection, link: &Link, id: u32, max_bytes: usize) -> Outcome {
    loop {
        let Ok(datagram) = connection.receive_datagram().await else {
            return Outcome::Gone;
        };
        let payload = datagram.payload();
        if payload.is_empty() || payload.len() > max_bytes {
            continue;
        }
        if !link
            .send(frame::encode(DATAGRAM, &[&id.to_be_bytes(), &payload]))
            .await
        {
            return Outcome::Gone;
        }
    }
}

/// Writes Node's DELIVER payloads to the stream, reporting the cumulative bytes written after each.
async fn write_loop(
    mut send: SendStream,
    mut rx: mpsc::UnboundedReceiver<Down>,
    link: &Link,
    id: u32,
) -> Outcome {
    let mut written: u64 = 0;
    while let Some(message) = rx.recv().await {
        match message {
            Down::Deliver(flag, payload) => {
                let framed = frame::encode(flag, &[&payload]);
                if send.write_all(&framed).await.is_err() {
                    return Outcome::Gone;
                }
                written += payload.len() as u64;
                let report = frame::encode(WRITTEN, &[&id.to_be_bytes(), &written.to_be_bytes()]);
                if !link.send(report).await {
                    return Outcome::Gone;
                }
            }
            Down::Close(code, reason) => {
                let _ = tokio::time::timeout(FLUSH_WAIT, send.finish()).await;
                return Outcome::Close(code, reason);
            }
        }
    }
    // Node's side of the session is gone only when the link was.
    Outcome::Close(CLOSE_GOING_AWAY, b"link lost".to_vec())
}

/// Accepts incoming TCP WebSocket connections (`ws://` in dev, `wss://` when configured with TLS).
async fn accept_ws_sessions(shared: Arc<Shared>, listener: TcpListener, tls: Option<TlsAcceptor>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let _ = stream.set_nodelay(true);
        let shared = shared.clone();
        let tls = tls.clone();
        tokio::spawn(async move {
            match tls {
                Some(acceptor) => {
                    if let Ok(tls_stream) = acceptor.accept(stream).await {
                        serve_ws_stream(shared, tls_stream).await;
                    }
                }
                None => serve_ws_stream(shared, stream).await,
            }
        });
    }
}

fn ws_reject(status: u16) -> ErrorResponse {
    let mut response = ErrorResponse::new(None);
    *response.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::from_u16(status)
        .unwrap_or(tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN);
    response
}

#[allow(clippy::result_large_err)]
fn ws_handshake(
    shared: &Shared,
    http_port: u16,
    request: &Request,
    response: Response,
) -> Result<Response, ErrorResponse> {
    if shared.accepted().is_none() {
        return Err(ws_reject(403));
    }
    if request.uri().path() != ARENA_PATH {
        return Err(ws_reject(404));
    }
    let origin = match request.headers().get("origin") {
        Some(value) => match value.to_str() {
            Ok(text) => Some(text),
            Err(_) => return Err(ws_reject(403)),
        },
        None => None,
    };
    let authority = request
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !origin::allowed(origin, authority, http_port) {
        return Err(ws_reject(403));
    }
    Ok(response)
}

#[allow(clippy::result_large_err)]
async fn serve_ws_stream<S>(shared: Arc<Shared>, stream: S)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Some(link) = shared.accepted() else {
        return;
    };
    let Some(params) = link.params.get() else {
        return;
    };
    let mut ws_config = WebSocketConfig::default();
    ws_config.max_message_size = Some(params.max_message_bytes);
    ws_config.max_frame_size = Some(params.max_message_bytes);
    let max_bytes = params.max_message_bytes;
    let http_port = params.http_port;

    let mut down = link.down.subscribe();
    let accepted = tokio::select! {
        res = tokio_tungstenite::accept_hdr_async_with_config(
            stream,
            |request: &Request, response: Response| ws_handshake(&shared, http_port, request, response),
            Some(ws_config),
        ) => res,
        _ = down.wait_for(|down| *down) => return,
    };
    let Ok(ws) = accepted else {
        return;
    };

    let id = link.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (close_requested, mut close_rx) = watch::channel(None::<tokio::time::Instant>);
    link.sessions.lock().unwrap().insert(
        id,
        Arc::new(Session {
            tx: tx.clone(),
            close_requested,
            datagrams: None,
        }),
    );
    if !link
        .send(frame::encode(
            OPEN,
            &[&id.to_be_bytes(), &[frame::STREAM_ONLY]],
        ))
        .await
    {
        link.sessions.lock().unwrap().remove(&id);
        return;
    }

    let (mut ws_sink, ws_stream) = ws.split();
    let outcome = tokio::select! {
        outcome = ws_read_loop(ws_stream, &link, id, max_bytes) => Some(outcome),
        outcome = ws_deliver_loop(&mut ws_sink, &mut rx, &link, id, &mut down) => Some(outcome),
        _ = async {
            let _ = close_rx.wait_for(|at| at.is_some()).await;
            let requested = *close_rx.borrow();
            if let Some(at) = requested {
                tokio::time::sleep_until(at + FLUSH_WAIT).await;
            }
        } => None,
    };
    let close_frame = match outcome {
        Some(WsOutcome::Close(code, reason)) => Some((code, reason)),
        Some(WsOutcome::LinkLost) => Some((CLOSE_GOING_AWAY, b"link lost".to_vec())),
        Some(WsOutcome::ClientClosed) => None,
        Some(WsOutcome::Gone) | None => {
            link.sessions.lock().unwrap().remove(&id);
            link.send(frame::encode(CLOSED, &[&id.to_be_bytes()])).await;
            return;
        }
    };
    // Bound teardown inside this session task, anchored to when CLOSE arrived if Node initiated closure.
    let flush_budget = close_rx.borrow().map_or(FLUSH_WAIT, |at| {
        (at + FLUSH_WAIT).saturating_duration_since(tokio::time::Instant::now())
    });
    let _ = tokio::time::timeout(flush_budget, async {
        if let Some((code, reason)) = close_frame {
            let frame = CloseFrame {
                code: CloseCode::from(code),
                reason: String::from_utf8_lossy(&reason).into_owned().into(),
            };
            let _ = ws_sink.send(Message::Close(Some(frame))).await;
        }
        let _ = ws_sink.close().await;
    })
    .await;
    link.sessions.lock().unwrap().remove(&id);
    link.send(frame::encode(CLOSED, &[&id.to_be_bytes()])).await;
}

enum WsOutcome {
    Close(u16, Vec<u8>),
    LinkLost,
    ClientClosed,
    Gone,
}

async fn ws_read_loop<S>(
    mut ws_stream: futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<S>>,
    link: &Link,
    id: u32,
    max_bytes: usize,
) -> WsOutcome
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    while let Some(item) = ws_stream.next().await {
        match item {
            Ok(Message::Text(text)) => {
                let bytes = text.as_bytes();
                if bytes.len() > max_bytes {
                    return WsOutcome::Close(CLOSE_POLICY, b"message too large".to_vec());
                }
                if !link
                    .send(frame::encode(
                        MESSAGE,
                        &[&id.to_be_bytes(), &[frame::TEXT], bytes],
                    ))
                    .await
                {
                    return WsOutcome::LinkLost;
                }
            }
            Ok(Message::Binary(bytes)) => {
                if bytes.len() > max_bytes {
                    return WsOutcome::Close(CLOSE_POLICY, b"message too large".to_vec());
                }
                if !link
                    .send(frame::encode(
                        MESSAGE,
                        &[&id.to_be_bytes(), &[frame::BINARY], &bytes],
                    ))
                    .await
                {
                    return WsOutcome::LinkLost;
                }
            }
            Ok(Message::Close(_)) => return WsOutcome::ClientClosed,
            Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => {}
            Err(WsError::Capacity(_)) => {
                return WsOutcome::Close(CLOSE_POLICY, b"message too large".to_vec());
            }
            Err(WsError::Protocol(_) | WsError::Utf8(_)) => {
                return WsOutcome::Close(CLOSE_POLICY, b"bad frame".to_vec());
            }
            Err(_) => return WsOutcome::Gone,
        }
    }
    WsOutcome::Gone
}

async fn ws_deliver_loop<S>(
    ws_sink: &mut futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<S>, Message>,
    rx: &mut mpsc::UnboundedReceiver<Down>,
    link: &Link,
    id: u32,
    down: &mut watch::Receiver<bool>,
) -> WsOutcome
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut written: u64 = 0;
    loop {
        let Some(message) = (tokio::select! {
            biased;
            _ = down.wait_for(|down| *down) => return WsOutcome::LinkLost,
            message = rx.recv() => message,
        }) else {
            return if *down.borrow() {
                WsOutcome::LinkLost
            } else {
                WsOutcome::Gone
            };
        };
        match message {
            Down::Deliver(flag, payload) => {
                let len = payload.len() as u64;
                let msg = if flag == frame::TEXT {
                    let Ok(text) = String::from_utf8(payload) else {
                        return WsOutcome::Gone;
                    };
                    Message::Text(text.into())
                } else {
                    Message::Binary(payload.into())
                };
                tokio::select! {
                    biased;
                    _ = down.wait_for(|down| *down) => return WsOutcome::LinkLost,
                    sent = ws_sink.send(msg) => {
                        if sent.is_err() {
                            return WsOutcome::Gone;
                        }
                    }
                }
                written += len;
                let report = frame::encode(WRITTEN, &[&id.to_be_bytes(), &written.to_be_bytes()]);
                if !link.send(report).await {
                    return WsOutcome::LinkLost;
                }
            }
            Down::Close(code, reason) => return WsOutcome::Close(code, reason),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::json_u64;

    #[test]
    fn reads_numbers_from_accept() {
        let json = r#"{"link":1, "httpPort" : 3000,"maxMessageBytes":65536}"#;
        assert_eq!(json_u64(json, "link"), Some(1));
        assert_eq!(json_u64(json, "httpPort"), Some(3000));
        assert_eq!(json_u64(json, "maxMessageBytes"), Some(65536));
        assert_eq!(json_u64(json, "missing"), None);
    }
}
