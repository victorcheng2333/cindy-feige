use crate::endpoints::APP_VERSION;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u32 = 1;
pub const CAPABILITY_BACKGROUND_LINK_V1: &str = "background-link-v1";
pub const CAPABILITY_RELIABLE_TRANSPORT_V1: &str = "reliable-transport-v1";
pub const CAPABILITY_RELIABLE_LINK_CONFIRM_V1: &str = "reliable-link-confirm-v1";
const TRANSPORT_MARKER: &str = "__cindyDeviceLinkTransport";
const TRANSPORT_SKIP_MARKER: &str = "__cindyDeviceLinkTransportSkip";
const TRANSPORT_ACK_CHANNEL: &str = "__cindy/device-link/transport-ack";
const MAX_TRANSPORT_CHUNK_BYTES: usize = 128 * 1024;
const MAX_TRANSPORT_REASSEMBLY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkAccept {
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub transport_stream_id: Option<String>,
    pub transport_base_seq: Option<u64>,
}

#[derive(Debug, Clone)]
pub enum InvokeOutcome {
    Ok(Value),
    #[allow(dead_code)]
    Err { code: String, message: String },
}

#[async_trait]
pub trait DeviceLinkSession: Send + Sync {
    async fn wait_until_online(&self, timeout: Duration) -> Result<(), String>;
    async fn open_link(&self, dst: &str, timeout: Duration) -> Result<LinkAccept, String>;
    async fn invoke(
        &self,
        dst: &str,
        channel: &str,
        args: Vec<Value>,
        timeout: Duration,
    ) -> Result<InvokeOutcome, String>;
    fn close_link(&self, dst: &str, reason: &str);
    fn stop(&self);
}

pub type TokenProvider =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<Option<String>, String>> + Send>> + Send + Sync>;

enum ActorCommand {
    OpenLink {
        dst: String,
        reply: oneshot::Sender<Result<LinkAccept, String>>,
    },
    Invoke {
        dst: String,
        channel: String,
        args: Vec<Value>,
        reply: oneshot::Sender<Result<InvokeOutcome, String>>,
    },
    CloseLink {
        dst: String,
        reason: String,
    },
    Stop,
}

struct PendingReply {
    dst: String,
    expect_kind: &'static str,
    tx: oneshot::Sender<Result<Value, String>>,
}

struct SegmentAssembly {
    kind: String,
    id: Option<String>,
    src: String,
    total: usize,
    total_bytes: usize,
    chunks: HashMap<usize, String>,
    bytes: usize,
}

struct ReadyMessage {
    kind: String,
    id: Option<String>,
    src: String,
    payload: Value,
}

struct PeerTransport {
    local_stream_id: String,
    next_seq: u64,
    reliable: bool,
    remote_stream_id: Option<String>,
    last_delivered_seq: u64,
    ready: BTreeMap<u64, ReadyMessage>,
    assemblies: HashMap<u64, SegmentAssembly>,
}

impl PeerTransport {
    fn new() -> Self {
        Self {
            local_stream_id: Uuid::new_v4().to_string(),
            next_seq: 1,
            reliable: false,
            remote_stream_id: None,
            last_delivered_seq: 0,
            ready: BTreeMap::new(),
            assemblies: HashMap::new(),
        }
    }

    fn reset_for_disconnect(&mut self) {
        self.reliable = false;
        self.remote_stream_id = None;
        self.ready.clear();
        self.assemblies.clear();
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct WireEnvelope {
    v: u32,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    src: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dst: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<Value>,
}

fn split_utf8_chunks(text: &str, max_bytes: usize) -> Vec<&str> {
    if text.len() <= max_bytes {
        return vec![text];
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut current_bytes = 0;
    for (idx, ch) in text.char_indices() {
        let len = ch.len_utf8();
        if idx > start && current_bytes + len > max_bytes {
            chunks.push(&text[start..idx]);
            start = idx;
            current_bytes = 0;
        }
        current_bytes += len;
    }
    if start < text.len() {
        chunks.push(&text[start..]);
    }
    chunks
}

fn encode_reliable_envelopes(
    dst: &str,
    kind: &str,
    id: &str,
    payload: &Value,
    stream_id: &str,
    seq: u64,
) -> Result<Vec<WireEnvelope>, String> {
    let raw = serde_json::to_string(payload).map_err(|_| "无法序列化请求".to_string())?;
    let total_bytes = raw.len();
    let chunks = split_utf8_chunks(&raw, MAX_TRANSPORT_CHUNK_BYTES);
    let total = chunks.len();
    let mut frames = Vec::with_capacity(total);
    for (index, chunk) in chunks.into_iter().enumerate() {
        let mut meta = serde_json::Map::new();
        meta.insert("version".to_string(), json!(1));
        meta.insert("streamId".to_string(), json!(stream_id));
        meta.insert("seq".to_string(), json!(seq));
        if seq > 1 {
            meta.insert("baseSeq".to_string(), json!(seq));
        }
        if total > 1 {
            meta.insert(
                "segment".to_string(),
                json!({
                    "index": index,
                    "total": total,
                    "totalBytes": total_bytes,
                }),
            );
        }
        let mut wrapper = serde_json::Map::new();
        wrapper.insert(TRANSPORT_MARKER.to_string(), Value::Object(meta));
        wrapper.insert("data".to_string(), json!(chunk));
        frames.push(WireEnvelope {
            v: PROTOCOL_VERSION,
            kind: kind.to_string(),
            id: Some(id.to_string()),
            src: None,
            dst: Some(dst.to_string()),
            payload: Some(Value::Object(wrapper)),
        });
    }
    Ok(frames)
}

fn make_transport_ack(dst: &str, stream_id: &str, ack_seq: u64, link_request_id: Option<&str>) -> WireEnvelope {
    let mut ack = serde_json::Map::new();
    ack.insert("streamId".to_string(), json!(stream_id));
    ack.insert("ackSeq".to_string(), json!(ack_seq));
    if let Some(req_id) = link_request_id {
        ack.insert("linkRequestId".to_string(), json!(req_id));
    }
    WireEnvelope {
        v: PROTOCOL_VERSION,
        kind: "push".to_string(),
        id: None,
        src: None,
        dst: Some(dst.to_string()),
        payload: Some(json!({
            "channel": TRANSPORT_ACK_CHANNEL,
            "payload": Value::Object(ack),
        })),
    }
}

pub struct WsDeviceLinkClient {
    cmd_tx: mpsc::UnboundedSender<ActorCommand>,
    online_rx: watch::Receiver<bool>,
    stopped: Mutex<bool>,
}

impl WsDeviceLinkClient {
    pub fn start(ws_url: String, get_token: TokenProvider) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (online_tx, online_rx) = watch::channel(false);
        tokio::spawn(run_actor(ws_url, get_token, cmd_rx, online_tx));
        Self {
            cmd_tx,
            online_rx,
            stopped: Mutex::new(false),
        }
    }
}

#[async_trait]
impl DeviceLinkSession for WsDeviceLinkClient {
    async fn wait_until_online(&self, timeout: Duration) -> Result<(), String> {
        let mut rx = self.online_rx.clone();
        if *rx.borrow() {
            return Ok(());
        }
        tokio::time::timeout(timeout, async move {
            loop {
                rx.changed().await.map_err(|_| "远端中转连接已关闭".to_string())?;
                if *rx.borrow() {
                    return Ok(());
                }
            }
        })
        .await
        .map_err(|_| "连接远端中转超时".to_string())?
    }

    async fn open_link(&self, dst: &str, timeout: Duration) -> Result<LinkAccept, String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(ActorCommand::OpenLink {
                dst: dst.to_string(),
                reply: tx,
            })
            .map_err(|_| "远端连接已停止".to_string())?;
        tokio::time::timeout(timeout, rx)
            .await
            .map_err(|_| "连接电脑超时".to_string())?
            .map_err(|_| "连接电脑中断".to_string())?
    }

    async fn invoke(
        &self,
        dst: &str,
        channel: &str,
        args: Vec<Value>,
        timeout: Duration,
    ) -> Result<InvokeOutcome, String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(ActorCommand::Invoke {
                dst: dst.to_string(),
                channel: channel.to_string(),
                args,
                reply: tx,
            })
            .map_err(|_| "远端连接已停止".to_string())?;
        tokio::time::timeout(timeout, rx)
            .await
            .map_err(|_| "读取远端额度超时".to_string())?
            .map_err(|_| "读取远端额度中断".to_string())?
    }

    fn close_link(&self, dst: &str, reason: &str) {
        let _ = self.cmd_tx.send(ActorCommand::CloseLink {
            dst: dst.to_string(),
            reason: reason.to_string(),
        });
    }

    fn stop(&self) {
        if let Ok(mut guard) = self.stopped.try_lock() {
            *guard = true;
        }
        let _ = self.cmd_tx.send(ActorCommand::Stop);
    }
}

async fn run_actor(
    ws_url: String,
    get_token: TokenProvider,
    mut cmd_rx: mpsc::UnboundedReceiver<ActorCommand>,
    online_tx: watch::Sender<bool>,
) {
    let mut peers: HashMap<String, PeerTransport> = HashMap::new();
    let mut backoff_ms = 1000_u64;

    loop {
        let _ = online_tx.send(false);
        let token = match tokio::time::timeout(Duration::from_secs(15), get_token()).await {
            Ok(Ok(Some(t))) => t,
            _ => {
                tokio::select! {
                    cmd = cmd_rx.recv() => {
                        if matches!(cmd, None | Some(ActorCommand::Stop)) { return; }
                    }
                    _ = tokio::time::sleep(Duration::from_millis(backoff_ms)) => {}
                }
                backoff_ms = (backoff_ms * 2).min(15_000);
                continue;
            }
        };

        let mut req = match ws_url.as_str().into_client_request() {
            Ok(r) => r,
            Err(_) => return,
        };
        if let Ok(hv) = HeaderValue::from_str(&format!("Bearer {token}")) {
            req.headers_mut().insert("Authorization", hv);
        }

        let connected = tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async(req),
        )
        .await;

        let (ws_stream, _) = match connected {
            Ok(Ok(pair)) => pair,
            _ => {
                tokio::select! {
                    cmd = cmd_rx.recv() => {
                        if matches!(cmd, None | Some(ActorCommand::Stop)) { return; }
                        reject_command(cmd, "无法连接远端中转");
                    }
                    _ = tokio::time::sleep(Duration::from_millis(backoff_ms)) => {}
                }
                backoff_ms = (backoff_ms * 2).min(15_000);
                continue;
            }
        };

        let (mut sink, mut stream) = ws_stream.split();
        let hello = WireEnvelope {
            v: PROTOCOL_VERSION,
            kind: "hello".to_string(),
            id: None,
            src: None,
            dst: None,
            payload: Some(json!({
                "deviceName": "猫猫 Mac",
                "platform": "darwin",
                "appVersion": APP_VERSION,
                "remoteControlEnabled": false,
                "busy": false,
            })),
        };
        if sink
            .send(Message::Text(serde_json::to_string(&hello).unwrap().into()))
            .await
            .is_err()
        {
            continue;
        }

        let mut pending: HashMap<String, PendingReply> = HashMap::new();
        let mut ping_interval = tokio::time::interval(Duration::from_secs(20));
        ping_interval.tick().await;
        let mut handshake_deadline = Box::pin(tokio::time::sleep(Duration::from_secs(15)));
        let mut is_online = false;

        for peer in peers.values_mut() {
            peer.reset_for_disconnect();
        }

        let should_exit = loop {
            tokio::select! {
                _ = &mut handshake_deadline, if !is_online => {
                    break false;
                }
                _ = ping_interval.tick(), if is_online => {
                    let ping = WireEnvelope {
                        v: PROTOCOL_VERSION,
                        kind: "ping".to_string(),
                        id: None,
                        src: None,
                        dst: None,
                        payload: None,
                    };
                    if sink.send(Message::Text(serde_json::to_string(&ping).unwrap().into())).await.is_err() {
                        break false;
                    }
                }
                maybe_msg = stream.next() => {
                    let Some(Ok(msg)) = maybe_msg else {
                        break false;
                    };
                    let text = match msg {
                        Message::Text(t) => t.to_string(),
                        Message::Binary(b) => match String::from_utf8(b.to_vec()) {
                            Ok(s) => s,
                            Err(_) => continue,
                        },
                        Message::Close(_) => break false,
                        _ => continue,
                    };
                    let Ok(env) = serde_json::from_str::<WireEnvelope>(&text) else {
                        continue;
                    };
                    if env.kind == "hello-ack" {
                        let ver = env.payload.as_ref()
                            .and_then(|p| p.get("serverProtocolVersion"))
                            .and_then(Value::as_u64);
                        if ver != Some(PROTOCOL_VERSION as u64) {
                            break true;
                        }
                        if !is_online {
                            is_online = true;
                            backoff_ms = 1000;
                            let _ = online_tx.send(true);
                        }
                        continue;
                    }
                    let outbound_acks = handle_inbound_envelope(env, &mut peers, &mut pending);
                    for ack in outbound_acks {
                        if let Ok(raw) = serde_json::to_string(&ack) {
                            let _ = sink.send(Message::Text(raw.into())).await;
                        }
                    }
                }
                maybe_cmd = cmd_rx.recv() => {
                    let Some(cmd) = maybe_cmd else {
                        break true;
                    };
                    match cmd {
                        ActorCommand::Stop => {
                            let _ = sink.close().await;
                            break true;
                        }
                        other if !is_online => {
                            reject_command(Some(other), "尚未连上远端中转");
                        }
                        ActorCommand::OpenLink { dst, reply } => {
                            let peer = peers.entry(dst.clone()).or_insert_with(PeerTransport::new);
                            peer.reset_for_disconnect();
                            let req_id = Uuid::new_v4().to_string();
                            let open_env = WireEnvelope {
                                v: PROTOCOL_VERSION,
                                kind: "link-open".to_string(),
                                id: Some(req_id.clone()),
                                src: None,
                                dst: Some(dst.clone()),
                                payload: Some(json!({
                                    "controllerName": "猫猫 Mac",
                                    "protocolVersion": PROTOCOL_VERSION,
                                    "appVersion": APP_VERSION,
                                    "capabilities": [
                                        CAPABILITY_BACKGROUND_LINK_V1,
                                        CAPABILITY_RELIABLE_TRANSPORT_V1,
                                        CAPABILITY_RELIABLE_LINK_CONFIRM_V1,
                                    ],
                                    "transportStreamId": peer.local_stream_id,
                                    "transportBaseSeq": peer.next_seq,
                                })),
                            };
                            let (val_tx, val_rx) = oneshot::channel();
                            pending.insert(req_id.clone(), PendingReply {
                                dst: dst.clone(),
                                expect_kind: "link-accept",
                                tx: val_tx,
                            });
                            if sink.send(Message::Text(serde_json::to_string(&open_env).unwrap().into())).await.is_err() {
                                pending.remove(&req_id);
                                let _ = reply.send(Err("发送连接请求失败".to_string()));
                                break false;
                            }
                            tokio::spawn(async move {
                                if let Ok(res) = val_rx.await {
                                    let mapped = res.and_then(|v| {
                                        serde_json::from_value::<LinkAccept>(v)
                                            .map_err(|_| "电脑握手响应格式不正确".to_string())
                                    });
                                    let _ = reply.send(mapped);
                                }
                            });
                        }
                        ActorCommand::Invoke { dst, channel, args, reply } => {
                            let peer = peers.entry(dst.clone()).or_insert_with(PeerTransport::new);
                            let req_id = Uuid::new_v4().to_string();
                            let invoke_payload = json!({ "channel": channel, "args": args });
                            let envelopes = if peer.reliable {
                                let seq = peer.next_seq;
                                peer.next_seq += 1;
                                match encode_reliable_envelopes(&dst, "invoke", &req_id, &invoke_payload, &peer.local_stream_id, seq) {
                                    Ok(frames) => frames,
                                    Err(e) => {
                                        let _ = reply.send(Err(e));
                                        continue;
                                    }
                                }
                            } else {
                                vec![WireEnvelope {
                                    v: PROTOCOL_VERSION,
                                    kind: "invoke".to_string(),
                                    id: Some(req_id.clone()),
                                    src: None,
                                    dst: Some(dst.clone()),
                                    payload: Some(invoke_payload),
                                }]
                            };
                            let (val_tx, val_rx) = oneshot::channel();
                            pending.insert(req_id.clone(), PendingReply {
                                dst: dst.clone(),
                                expect_kind: "invoke-result",
                                tx: val_tx,
                            });
                            let mut send_failed = false;
                            for frame in envelopes {
                                if sink.send(Message::Text(serde_json::to_string(&frame).unwrap().into())).await.is_err() {
                                    send_failed = true;
                                    break;
                                }
                            }
                            if send_failed {
                                pending.remove(&req_id);
                                let _ = reply.send(Err("发送远端请求失败".to_string()));
                                break false;
                            }
                            tokio::spawn(async move {
                                if let Ok(res) = val_rx.await {
                                    let mapped = res.map(parse_invoke_result);
                                    let _ = reply.send(mapped);
                                }
                            });
                        }
                        ActorCommand::CloseLink { dst, reason } => {
                            if let Some(peer) = peers.get_mut(&dst) {
                                peer.reset_for_disconnect();
                            }
                            let close_env = WireEnvelope {
                                v: PROTOCOL_VERSION,
                                kind: "link-close".to_string(),
                                id: None,
                                src: None,
                                dst: Some(dst),
                                payload: Some(json!({ "reason": reason })),
                            };
                            let _ = sink.send(Message::Text(serde_json::to_string(&close_env).unwrap().into())).await;
                        }
                    }
                }
            }
        };

        for (_, p) in pending.drain() {
            let _ = p.tx.send(Err("远端连接已断开".to_string()));
        }
        let _ = online_tx.send(false);
        if should_exit {
            return;
        }
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(15_000);
    }
}

fn reject_command(cmd: Option<ActorCommand>, reason: &str) {
    match cmd {
        Some(ActorCommand::OpenLink { reply, .. }) => {
            let _ = reply.send(Err(reason.to_string()));
        }
        Some(ActorCommand::Invoke { reply, .. }) => {
            let _ = reply.send(Err(reason.to_string()));
        }
        _ => {}
    }
}

fn parse_invoke_result(payload: Value) -> InvokeOutcome {
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        return InvokeOutcome::Ok(payload.get("result").cloned().unwrap_or(Value::Null));
    }
    let err = payload.get("error").and_then(Value::as_object);
    let code = err
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("IPC_ERROR")
        .to_string();
    let message = err
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("invoke failed")
        .to_string();
    InvokeOutcome::Err { code, message }
}

fn handle_inbound_envelope(
    env: WireEnvelope,
    peers: &mut HashMap<String, PeerTransport>,
    pending: &mut HashMap<String, PendingReply>,
) -> Vec<WireEnvelope> {
    let mut acks = Vec::new();

    if env.kind == "relay-error" {
        if let Some(id) = env.id.as_deref() {
            if let Some(p) = pending.remove(id) {
                let msg = env
                    .payload
                    .as_ref()
                    .and_then(|pl| pl.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("relay error")
                    .to_string();
                let _ = p.tx.send(Err(msg));
            }
        }
        return acks;
    }

    if env.kind == "link-close" {
        if let Some(src) = env.src.as_deref() {
            if let Some(peer) = peers.get_mut(src) {
                peer.reset_for_disconnect();
            }
        }
        return acks;
    }

    // Check if wrapped in reliable-transport-v1
    if let (Some(src), Some(payload_obj)) = (env.src.as_deref(), env.payload.as_ref().and_then(Value::as_object)) {
        if let Some(meta) = payload_obj.get(TRANSPORT_MARKER).and_then(Value::as_object) {
            if meta.get("version").and_then(Value::as_u64) == Some(1) {
                let Some(stream_id) = meta.get("streamId").and_then(Value::as_str) else {
                    return acks;
                };
                let Some(seq) = meta.get("seq").and_then(Value::as_u64) else {
                    return acks;
                };
                let Some(data_str) = payload_obj.get("data").and_then(Value::as_str) else {
                    return acks;
                };
                let Some(peer) = peers.get_mut(src) else {
                    return acks;
                };
                if !peer.reliable {
                    return acks;
                }
                if let Some(expected_stream) = peer.remote_stream_id.as_deref() {
                    if expected_stream != stream_id {
                        return acks;
                    }
                } else {
                    peer.remote_stream_id = Some(stream_id.to_string());
                }
                if let Some(base_seq) = meta.get("baseSeq").and_then(Value::as_u64) {
                    if base_seq > 1 && peer.last_delivered_seq < base_seq - 1 {
                        peer.last_delivered_seq = base_seq - 1;
                    }
                }
                if seq <= peer.last_delivered_seq {
                    acks.push(make_transport_ack(src, stream_id, peer.last_delivered_seq, None));
                    return acks;
                }
                if let Some(seg) = meta.get("segment").and_then(Value::as_object) {
                    let (Some(index), Some(total), Some(total_bytes)) = (
                        seg.get("index").and_then(Value::as_u64).map(|n| n as usize),
                        seg.get("total").and_then(Value::as_u64).map(|n| n as usize),
                        seg.get("totalBytes").and_then(Value::as_u64).map(|n| n as usize),
                    ) else {
                        return acks;
                    };
                    if total_bytes > MAX_TRANSPORT_REASSEMBLY_BYTES || index >= total || total < 2 {
                        return acks;
                    }
                    let entry = peer.assemblies.entry(seq).or_insert_with(|| SegmentAssembly {
                        kind: env.kind.clone(),
                        id: env.id.clone(),
                        src: src.to_string(),
                        total,
                        total_bytes,
                        chunks: HashMap::new(),
                        bytes: 0,
                    });
                    if !entry.chunks.contains_key(&index) {
                        entry.bytes += data_str.len();
                        entry.chunks.insert(index, data_str.to_string());
                    }
                    if entry.chunks.len() == entry.total {
                        let completed = peer.assemblies.remove(&seq).unwrap();
                        let mut full = String::with_capacity(completed.total_bytes);
                        for i in 0..completed.total {
                            if let Some(part) = completed.chunks.get(&i) {
                                full.push_str(part);
                            }
                        }
                        if let Ok(decoded) = serde_json::from_str::<Value>(&full) {
                            peer.ready.insert(
                                seq,
                                ReadyMessage {
                                    kind: completed.kind,
                                    id: completed.id,
                                    src: completed.src,
                                    payload: decoded,
                                },
                            );
                        }
                    }
                } else if let Ok(decoded) = serde_json::from_str::<Value>(data_str) {
                    peer.ready.insert(
                        seq,
                        ReadyMessage {
                            kind: env.kind.clone(),
                            id: env.id.clone(),
                            src: src.to_string(),
                            payload: decoded,
                        },
                    );
                }

                let mut drained = Vec::new();
                while let Some(ready) = peer.ready.remove(&(peer.last_delivered_seq + 1)) {
                    peer.last_delivered_seq += 1;
                    drained.push(ready);
                }
                let progressed = !drained.is_empty();
                for ready in drained {
                    let is_skip = ready
                        .payload
                        .as_object()
                        .and_then(|o| o.get(TRANSPORT_SKIP_MARKER))
                        .and_then(Value::as_bool)
                        == Some(true);
                    if !is_skip {
                        deliver_logical_frame(
                            &ready.kind,
                            ready.id.as_deref(),
                            &ready.src,
                            ready.payload,
                            peers,
                            pending,
                            &mut acks,
                        );
                    }
                }
                if progressed {
                    if let Some(peer_after) = peers.get(src) {
                        if let Some(rs) = peer_after.remote_stream_id.as_deref() {
                            acks.push(make_transport_ack(src, rs, peer_after.last_delivered_seq, None));
                        }
                    }
                }
                return acks;
            }
        }
    }

    if let Some(src) = env.src.as_deref() {
        deliver_logical_frame(
            &env.kind,
            env.id.as_deref(),
            src,
            env.payload.unwrap_or(Value::Null),
            peers,
            pending,
            &mut acks,
        );
    }
    acks
}

fn deliver_logical_frame(
    kind: &str,
    id: Option<&str>,
    src: &str,
    payload: Value,
    peers: &mut HashMap<String, PeerTransport>,
    pending: &mut HashMap<String, PendingReply>,
    acks: &mut Vec<WireEnvelope>,
) {
    let Some(req_id) = id else { return };
    let Some(entry) = pending.get(req_id) else { return };
    if entry.dst != src || entry.expect_kind != kind {
        return;
    }
    let entry = pending.remove(req_id).unwrap();
    if kind == "link-accept" {
        if let Ok(accepted) = serde_json::from_value::<LinkAccept>(payload.clone()) {
            if accepted
                .capabilities
                .iter()
                .any(|c| c == CAPABILITY_RELIABLE_TRANSPORT_V1)
            {
                let peer = peers.entry(src.to_string()).or_insert_with(PeerTransport::new);
                peer.reliable = true;
                peer.remote_stream_id = accepted.transport_stream_id.clone();
                let base_seq = accepted.transport_base_seq.unwrap_or(1).max(1);
                peer.last_delivered_seq = base_seq - 1;
                if accepted
                    .capabilities
                    .iter()
                    .any(|c| c == CAPABILITY_RELIABLE_LINK_CONFIRM_V1)
                {
                    if let Some(remote_stream) = peer.remote_stream_id.as_deref() {
                        acks.push(make_transport_ack(
                            src,
                            remote_stream,
                            peer.last_delivered_seq,
                            Some(req_id),
                        ));
                    }
                }
            }
        }
    }
    let _ = entry.tx.send(Ok(payload));
}
