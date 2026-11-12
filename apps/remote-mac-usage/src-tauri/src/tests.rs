use crate::auth::{
    build_sso_authorize_url, create_proof, login_sso, AuthApi, AuthApiError,
    DesktopAuthorizationPoll, LoginOutcome, OpenUrlFn, SsoOrgDiscovery,
};
use crate::device_link::{
    DeviceLinkSession, InvokeOutcome, LinkAccept, CAPABILITY_BACKGROUND_LINK_V1,
};
use crate::model::{
    current_quota, missing_reset_text, parse_account, parse_devices, tray_window_position,
    validate_command, Command, IntRect,
};
use crate::service::{UsageService, UsageServiceDeps};
use crate::storage::{
    decrypt_oscrypt_v10, derive_macos_oscrypt_v10_key, encrypt_oscrypt_v10, load_device_id,
    AuthMembership, AuthTokenPair, Cipher, EncryptedSessionStore, SavedView, SessionStore,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{Notify, watch};
use uuid::Uuid;

fn fake_tokens(member_id: &str) -> AuthTokenPair {
    AuthTokenPair {
        access_token: "fake-access".to_string(),
        refresh_token: "fake-refresh".to_string(),
        membership: AuthMembership {
            id: member_id.to_string(),
            passport_id: None,
            kind: "personal".to_string(),
            role: "owner".to_string(),
            display_name: "Test".to_string(),
            avatar_url: None,
            email: None,
            org_id: None,
            org_name: None,
            org_logo_url: None,
        },
    }
}

struct TempDirGuard(PathBuf);

impl TempDirGuard {
    fn new(prefix: &str) -> Self {
        let p = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct FakeCipher {
    available: AtomicBool,
    fail_decrypt: AtomicBool,
}

impl FakeCipher {
    fn new(available: bool) -> Arc<Self> {
        Arc::new(Self {
            available: AtomicBool::new(available),
            fail_decrypt: AtomicBool::new(false),
        })
    }
}

impl Cipher for FakeCipher {
    fn is_encryption_available(&self) -> bool {
        self.available.load(Ordering::SeqCst)
    }

    fn encrypt_string(&self, text: &str) -> Result<Vec<u8>, String> {
        Ok(format!("enc:{text}").into_bytes())
    }

    fn decrypt_string(&self, bytes: &[u8]) -> Result<String, String> {
        if self.fail_decrypt.load(Ordering::SeqCst) {
            return Err("corrupt".to_string());
        }
        let s = std::str::from_utf8(bytes).map_err(|_| "utf8".to_string())?;
        s.strip_prefix("enc:")
            .map(ToString::to_string)
            .ok_or_else(|| "bad header".to_string())
    }
}

#[tokio::test]
async fn storage_encrypts_restores_and_respects_keychain_availability() {
    let dir = TempDirGuard::new("qcat-rust-store");
    let cipher = FakeCipher::new(true);
    let store = EncryptedSessionStore::new(&dir.0, cipher.clone());
    let tok = fake_tokens("fake-member");
    store.save(Some(tok.clone())).await.unwrap();

    let raw = std::fs::read_to_string(dir.0.join("session.enc")).unwrap();
    assert!(raw.starts_with("enc:"));
    assert_eq!(store.load().await.unwrap(), Some(tok));

    // Refuses write when encryption unavailable
    let dir2 = TempDirGuard::new("qcat-rust-nokey");
    let unavailable = FakeCipher::new(false);
    let store2 = EncryptedSessionStore::new(&dir2.0, unavailable);
    let err = store2.save(Some(fake_tokens("m"))).await.unwrap_err();
    assert!(err.contains("钥匙串"));
    assert!(!dir2.0.join("session.enc").exists());
}

#[tokio::test]
async fn storage_preserves_corrupt_file_and_restores_legacy_view() {
    let dir = TempDirGuard::new("qcat-rust-corrupt");
    std::fs::write(dir.0.join("session.enc"), b"corrupt-bytes").unwrap();
    let cipher = FakeCipher::new(true);
    cipher.fail_decrypt.store(true, Ordering::SeqCst);
    let store = EncryptedSessionStore::new(&dir.0, cipher);
    let err = store.load().await.unwrap_err();
    assert!(err.contains("原文件已保留"));
    assert_eq!(std::fs::read(dir.0.join("session.enc")).unwrap(), b"corrupt-bytes");

    // Legacy single-device view.json compatibility
    std::fs::write(
        dir.0.join("view.json"),
        r#"{"ownerId":"fake-member","deviceId":"fake-mac"}"#,
    )
    .unwrap();
    assert_eq!(
        store.load_view().await.unwrap(),
        Some(SavedView {
            owner_id: "fake-member".to_string(),
            device_ids: vec!["fake-mac".to_string()],
            device_order: Vec::new(),
        })
    );
}

#[test]
fn oscrypt_v10_roundtrips_electron_safe_storage_format() {
    let key = derive_macos_oscrypt_v10_key(b"fake-keychain-base64-secret==");
    let sample = serde_json::to_string(&fake_tokens("fake-member")).unwrap();
    let encrypted = encrypt_oscrypt_v10(&sample, &key).unwrap();
    assert_eq!(&encrypted[..3], b"v10");
    let decrypted = decrypt_oscrypt_v10(&encrypted, &key).unwrap();
    assert_eq!(decrypted, sample);
    assert!(decrypt_oscrypt_v10(b"corrupt", &key).is_err());
}

#[test]
fn device_id_creates_and_validates_namespace() {
    let dir = TempDirGuard::new("qcat-rust-devid");
    let id1 = load_device_id(&dir.0).unwrap();
    let id2 = load_device_id(&dir.0).unwrap();
    assert_eq!(id1, id2);
    assert!(id1.starts_with("quota-cat-"));
}

#[test]
fn quota_parsing_and_codex_buckets_match_contract() {
    let claude_provider = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
        "id": "anthropic",
        "name": "工作账号",
        "connected": true,
        "auth": { "native": "claude", "method": "oauth" }
    }))
    .unwrap();

    let acc = parse_account(
        &claude_provider,
        &json!({ "fiveHour": { "utilization": 0, "resetsAt": null } }),
        1_700_000_000_000.0,
    )
    .unwrap();
    assert_eq!(acc.windows[0].resets_at, None);
    assert_eq!(
        missing_reset_text(&acc.windows[0]),
        "当前未使用 · 来源未返回重置时间"
    );

    // Independent account requires matching providerId
    let second_provider = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
        "id": "second",
        "name": "第二账号",
        "connected": true,
        "auth": { "native": "claude", "method": "oauth" }
    }))
    .unwrap();
    assert!(parse_account(
        &second_provider,
        &json!({ "providerId": "anthropic", "fiveHour": { "utilization": 32, "resetsAt": 4_000_000_000_i64 } }),
        1_700_000_000_000.0
    )
    .is_err());

    // Generic codex bucket preferred ahead of model-specific spark bucket
    let openai_provider = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
        "id": "openai",
        "name": "ChatGPT",
        "connected": true,
        "auth": { "native": "codex", "method": "oauth" }
    }))
    .unwrap();
    let codex_acc = parse_account(
        &openai_provider,
        &json!({
            "rateLimitsByLimitId": {
                "spark": { "limitId": "spark", "limitName": "GPT-5.3-Codex-Spark", "primary": { "usedPercent": 99 } },
                "codex": { "limitId": "codex", "primary": { "usedPercent": 20, "windowMinutes": 300 } }
            }
        }),
        1_700_000_000_000.0,
    )
    .unwrap();
    assert_eq!(codex_acc.windows[0].remaining, 80.0);
    assert_eq!(codex_acc.windows[0].minutes, Some(300));
    assert!(current_quota(Some(&codex_acc.windows[0]), 1_700_000_000_000.0));
}

#[test]
fn parse_devices_excludes_viewers_and_mobile_and_validates_commands() {
    let parsed = parse_devices(
        &json!({
            "devices": [
                { "deviceId": "self", "name": "self", "online": true, "remoteControlEnabled": true, "platform": "darwin" },
                { "deviceId": "quota-cat-other", "name": "猫猫 Mac", "online": true, "remoteControlEnabled": false, "platform": "darwin" },
                { "deviceId": "host-a", "name": "猫猫 Mac", "online": true, "remoteControlEnabled": false, "platform": "darwin" },
                { "deviceId": "host-b", "name": "Studio", "online": false, "remoteControlEnabled": true, "platform": "darwin" },
                { "deviceId": "phone", "name": "iPhone", "online": true, "remoteControlEnabled": true, "platform": "ios" }
            ]
        }),
        "self",
    )
    .unwrap();
    let ids: Vec<&str> = parsed.iter().map(|d| d.device_id.as_str()).collect();
    assert_eq!(ids, vec!["host-a", "host-b"]);

    assert!(validate_command(&json!({ "kind": "invoke", "channel": "maker:send" })).is_err());
    assert!(validate_command(&json!({ "kind": "refresh", "deviceId": "x" })).is_err());
    assert!(validate_command(&json!({ "kind": "sso", "org": "" })).is_err());
    assert_eq!(
        validate_command(&json!({ "kind": "select-devices", "deviceIds": ["a", "b"] })).unwrap(),
        Command::SelectDevices {
            device_ids: vec!["a".to_string(), "b".to_string()]
        }
    );

    assert_eq!(
        tray_window_position(
            IntRect { x: 1000, y: 0, width: 17, height: 24 },
            IntRect { x: 0, y: 24, width: 1920, height: 1056 },
            (468, 728)
        ),
        (775, 32)
    );
    assert_eq!(
        tray_window_position(
            IntRect { x: -10, y: 0, width: 17, height: 24 },
            IntRect { x: -1280, y: 24, width: 1280, height: 696 },
            (468, 728)
        ),
        (-468, 24)
    );
}

#[test]
fn pkce_proof_keeps_secrets_out_of_authorize_url() {
    let proof = create_proof();
    assert_ne!(proof.verifier, proof.poll_secret);
    let url = build_sso_authorize_url(
        "https://example.invalid",
        "quota-cat-test",
        "xd-oidc",
        "https://example.invalid/callback",
        &proof.challenge,
        &proof.state,
    )
    .unwrap();
    assert!(!url.contains(&proof.verifier));
    assert!(!url.contains(&proof.poll_secret));
}

struct MockStore {
    tokens: StdMutex<Option<AuthTokenPair>>,
    view: StdMutex<Option<SavedView>>,
}

#[async_trait]
impl SessionStore for MockStore {
    async fn load(&self) -> Result<Option<AuthTokenPair>, String> {
        Ok(self.tokens.lock().unwrap().clone())
    }
    async fn save(&self, value: Option<AuthTokenPair>) -> Result<(), String> {
        if value.is_none() {
            *self.view.lock().unwrap() = None;
        }
        *self.tokens.lock().unwrap() = value;
        Ok(())
    }
    async fn load_view(&self) -> Result<Option<SavedView>, String> {
        Ok(self.view.lock().unwrap().clone())
    }
    async fn save_view(&self, value: SavedView) -> Result<(), String> {
        *self.view.lock().unwrap() = Some(value);
        Ok(())
    }
}

struct MockAuth {
    devices: StdMutex<Value>,
    offline_once: AtomicBool,
    revoked: AtomicBool,
}

#[async_trait]
impl AuthApi for MockAuth {
    async fn discover_sso_org(&self, _org: &str) -> Result<SsoOrgDiscovery, AuthApiError> {
        unimplemented!()
    }
    fn authorize_url(&self, _c: &str, _ch: &str, _st: &str) -> Result<String, AuthApiError> {
        Ok("https://example.invalid/authorize".to_string())
    }
    async fn poll_desktop_authorization(&self, _ps: &str) -> Result<DesktopAuthorizationPoll, AuthApiError> {
        Ok(DesktopAuthorizationPoll::Ok { code: "fake-code".to_string() })
    }
    async fn exchange_authorization_code(&self, _c: &str, _v: &str) -> Result<LoginOutcome, AuthApiError> {
        Ok(LoginOutcome::Ok(fake_tokens("fake-member")))
    }
    async fn select_account(&self, _t: &str, _a: &str) -> Result<LoginOutcome, AuthApiError> {
        unimplemented!()
    }
    async fn request_sso_verification_code(&self, _t: &str) -> Result<(), AuthApiError> {
        Ok(())
    }
    async fn verify_sso_verification(&self, _t: &str, _c: &str) -> Result<LoginOutcome, AuthApiError> {
        unimplemented!()
    }
    async fn request_code(&self, _k: &str, _i: &str) -> Result<(), AuthApiError> {
        Ok(())
    }
    async fn verify_code(&self, _k: &str, _i: &str, _c: &str) -> Result<LoginOutcome, AuthApiError> {
        Ok(LoginOutcome::Ok(fake_tokens("fake-member")))
    }
    async fn refresh(&self, _rt: &str) -> Result<AuthTokenPair, AuthApiError> {
        if self.offline_once.swap(false, Ordering::SeqCst) {
            return Err(AuthApiError {
                code: "NETWORK_ERROR".to_string(),
                status_code: 0,
                message: "offline".to_string(),
            });
        }
        if self.revoked.load(Ordering::SeqCst) {
            return Err(AuthApiError {
                code: "INVALID_REFRESH_TOKEN".to_string(),
                status_code: 401,
                message: "revoked".to_string(),
            });
        }
        Ok(fake_tokens("fake-member"))
    }
    async fn list_devices(&self, _base: &str, _tok: &str) -> Result<Value, String> {
        Ok(self.devices.lock().unwrap().clone())
    }
}

struct MockLink {
    capabilities: Vec<String>,
    calls: StdMutex<Vec<(String, Vec<Value>)>>,
    closed: AtomicBool,
    gate: Option<(Arc<Notify>, Arc<Notify>)>,
}

#[async_trait]
impl DeviceLinkSession for MockLink {
    async fn wait_until_online(&self, _timeout: Duration) -> Result<(), String> {
        Ok(())
    }
    async fn open_link(&self, dst: &str, _timeout: Duration) -> Result<LinkAccept, String> {
        if dst == "fail-peer" {
            return Err("unreachable".to_string());
        }
        Ok(LinkAccept {
            capabilities: self.capabilities.clone(),
            transport_stream_id: None,
            transport_base_seq: None,
        })
    }
    async fn invoke(
        &self,
        _dst: &str,
        channel: &str,
        args: Vec<Value>,
        _timeout: Duration,
    ) -> Result<InvokeOutcome, String> {
        self.calls.lock().unwrap().push((channel.to_string(), args.clone()));
        if channel == "maker:provider:list" {
            return Ok(InvokeOutcome::Ok(json!({
                "providers": [{
                    "id": "anthropic",
                    "name": "工作账号",
                    "connected": true,
                    "auth": { "native": "claude", "method": "oauth" }
                }]
            })));
        }
        if let Some((entered, release)) = &self.gate {
            entered.notify_waiters();
            release.notified().await;
        }
        Ok(InvokeOutcome::Ok(json!({
            "providerId": "anthropic",
            "fiveHour": { "utilization": 32, "resetsAt": 4_000_000_000_i64 }
        })))
    }
    fn close_link(&self, _dst: &str, _reason: &str) {
        self.closed.store(true, Ordering::SeqCst);
    }
    fn stop(&self) {}
}

#[tokio::test]
async fn service_reads_default_scope_isolates_failed_peers_and_discards_late_logout_reads() {
    let store = Arc::new(MockStore {
        tokens: StdMutex::new(Some(fake_tokens("fake-member"))),
        view: StdMutex::new(None),
    });
    let auth = Arc::new(MockAuth {
        devices: StdMutex::new(json!({
            "devices": [
                { "deviceId": "a", "name": "Mac A", "online": true, "remoteControlEnabled": true, "platform": "darwin" },
                { "deviceId": "fail-peer", "name": "Mac B", "online": true, "remoteControlEnabled": true, "platform": "darwin" }
            ]
        })),
        offline_once: AtomicBool::new(false),
        revoked: AtomicBool::new(false),
    });
    let link = Arc::new(MockLink {
        capabilities: vec![CAPABILITY_BACKGROUND_LINK_V1.to_string()],
        calls: StdMutex::new(Vec::new()),
        closed: AtomicBool::new(false),
        gate: None,
    });
    let link_for_factory = link.clone();
    let svc = UsageService::new(UsageServiceDeps {
        device_id: "self".to_string(),
        device_link_base_url: "https://example.invalid".to_string(),
        store: store.clone(),
        auth: auth.clone(),
        open_url: Box::new(|_| Box::pin(async { Ok(()) })),
        publish: Box::new(|_| {}),
        create_link: Some(Box::new(move |_| link_for_factory.clone())),
    });

    svc.restore().await;
    assert!(svc.snapshot().await.signed_in);
    svc.refresh().await;

    let snap = svc.snapshot().await;
    assert_eq!(snap.devices[0].accounts[0].windows[0].remaining, 68.0);
    assert!(snap.devices[1].error.is_some());
    assert!(!serde_json::to_string(&snap).unwrap().contains("fake-access"));

    let calls = link.calls.lock().unwrap().clone();
    assert!(calls.contains(&(
        "maker:usage:claude-subscription".to_string(),
        vec![json!("anthropic"), json!(false), json!("default-subscription-account")]
    )));

    // Concurrent selection + ordering persistence
    let s1 = svc.clone();
    let s2 = svc.clone();
    tokio::join!(
        s1.command(Command::SelectDevices { device_ids: vec!["a".to_string()] }),
        s2.command(Command::ReorderDevices { device_ids: vec!["fail-peer".to_string(), "a".to_string()] }),
    );
    let saved = store.load_view().await.unwrap().unwrap();
    assert_eq!(saved.device_ids, vec!["a".to_string()]);
    assert_eq!(saved.device_order, vec!["fail-peer".to_string(), "a".to_string()]);

    // Transient refresh failure keeps session; revoked refresh clears session (fresh instance with fresh_at=0)
    let store2 = Arc::new(MockStore {
        tokens: StdMutex::new(Some(fake_tokens("fake-member"))),
        view: StdMutex::new(None),
    });
    let auth2 = Arc::new(MockAuth {
        devices: StdMutex::new(json!({ "devices": [] })),
        offline_once: AtomicBool::new(true),
        revoked: AtomicBool::new(true),
    });
    let svc2 = UsageService::new(UsageServiceDeps {
        device_id: "self".to_string(),
        device_link_base_url: "https://example.invalid".to_string(),
        store: store2.clone(),
        auth: auth2,
        open_url: Box::new(|_| Box::pin(async { Ok(()) })),
        publish: Box::new(|_| {}),
        create_link: None,
    });
    svc2.restore().await;
    svc2.refresh().await;
    assert!(svc2.snapshot().await.signed_in);
    assert!(store2.load().await.unwrap().is_some());
    svc2.refresh().await;
    assert!(!svc2.snapshot().await.signed_in);
    assert!(store2.load().await.unwrap().is_none());
}

#[tokio::test]
async fn service_closes_peer_without_background_capability_and_handles_sso_poll() {
    let store = Arc::new(MockStore {
        tokens: StdMutex::new(Some(fake_tokens("fake-member"))),
        view: StdMutex::new(None),
    });
    let auth = Arc::new(MockAuth {
        devices: StdMutex::new(json!({
            "devices": [{ "deviceId": "old-host", "name": "Old Mac", "online": true, "remoteControlEnabled": true, "platform": "darwin" }]
        })),
        offline_once: AtomicBool::new(false),
        revoked: AtomicBool::new(false),
    });
    let link = Arc::new(MockLink {
        capabilities: Vec::new(),
        calls: StdMutex::new(Vec::new()),
        closed: AtomicBool::new(false),
        gate: None,
    });
    let link_for_factory = link.clone();
    let svc = UsageService::new(UsageServiceDeps {
        device_id: "self".to_string(),
        device_link_base_url: "https://example.invalid".to_string(),
        store,
        auth: auth.clone(),
        open_url: Box::new(|_| Box::pin(async { Ok(()) })),
        publish: Box::new(|_| {}),
        create_link: Some(Box::new(move |_| link_for_factory.clone())),
    });
    svc.restore().await;
    svc.refresh().await;
    assert!(link.closed.load(Ordering::SeqCst));
    assert!(link.calls.lock().unwrap().is_empty());
    assert!(svc.snapshot().await.devices[0]
        .error
        .as_deref()
        .unwrap_or("")
        .contains("更新"));

    // SSO poll waits after macOS open resolves
    let (_tx, rx) = watch::channel(false);
    let open: OpenUrlFn = Box::new(|_| Box::pin(async { Ok(()) }));
    let outcome = login_sso(auth.as_ref(), "conn", rx, &open).await.unwrap();
    assert!(matches!(outcome, LoginOutcome::Ok(_)));
}

#[tokio::test]
async fn logout_discards_in_flight_quota_response() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let store = Arc::new(MockStore {
        tokens: StdMutex::new(Some(fake_tokens("fake-member"))),
        view: StdMutex::new(None),
    });
    let auth = Arc::new(MockAuth {
        devices: StdMutex::new(json!({
            "devices": [{ "deviceId": "a", "name": "Mac A", "online": true, "remoteControlEnabled": true, "platform": "darwin" }]
        })),
        offline_once: AtomicBool::new(false),
        revoked: AtomicBool::new(false),
    });
    let link = Arc::new(MockLink {
        capabilities: vec![CAPABILITY_BACKGROUND_LINK_V1.to_string()],
        calls: StdMutex::new(Vec::new()),
        closed: AtomicBool::new(false),
        gate: Some((entered.clone(), release.clone())),
    });
    let link_for_factory = link.clone();
    let svc = UsageService::new(UsageServiceDeps {
        device_id: "self".to_string(),
        device_link_base_url: "https://example.invalid".to_string(),
        store,
        auth,
        open_url: Box::new(|_| Box::pin(async { Ok(()) })),
        publish: Box::new(|_| {}),
        create_link: Some(Box::new(move |_| link_for_factory.clone())),
    });
    svc.restore().await;
    let svc_refresh = svc.clone();
    let waiter = entered.notified();
    let handle = tokio::spawn(async move {
        svc_refresh.refresh().await;
    });
    waiter.await;
    svc.logout().await.unwrap();
    release.notify_waiters();
    handle.await.unwrap();
    assert!(!svc.snapshot().await.signed_in);
    assert!(svc.snapshot().await.devices.is_empty());
}
