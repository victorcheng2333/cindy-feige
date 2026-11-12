use crate::auth::{login_sso, AuthApi, AuthApiError, LoginOutcome, OpenUrlFn};
use crate::device_link::{
    DeviceLinkSession, InvokeOutcome, TokenProvider, WsDeviceLinkClient, CAPABILITY_BACKGROUND_LINK_V1,
};
use crate::model::{
    empty_account, now_ms, parse_account, parse_devices, subscription_providers, Account, Command,
    LoginChoice, LoginView, ServiceKind, Snapshot,
};
use crate::storage::{AuthTokenPair, SavedView, SessionStore};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Mutex};

const DEFAULT_ACCOUNT_USAGE_SCOPE: &str = "default-subscription-account";
const TOKEN_FRESH_MS: f64 = 5.0 * 60.0 * 1000.0;

pub type LinkFactory = Box<dyn Fn(TokenProvider) -> Arc<dyn DeviceLinkSession> + Send + Sync>;
pub type PublishFn = Box<dyn Fn(Snapshot) + Send + Sync>;

struct InnerState {
    snapshot: Snapshot,
    tokens: Option<AuthTokenPair>,
    epoch: u64,
    fresh_at_ms: f64,
    pending_login: Option<LoginOutcome>,
    code_sent_to: Option<String>,
    code_after_ms: f64,
    link: Option<Arc<dyn DeviceLinkSession>>,
    sso_cancel: Option<watch::Sender<bool>>,
    action_running: bool,
    logout_running: bool,
    refresh_waiters: Vec<watch::Sender<()>>,
    token_waiters: Vec<watch::Sender<Result<Option<String>, String>>>,
}

pub struct UsageServiceDeps {
    pub device_id: String,
    pub device_link_base_url: String,
    pub store: Arc<dyn SessionStore>,
    pub auth: Arc<dyn AuthApi>,
    pub open_url: OpenUrlFn,
    pub publish: PublishFn,
    pub create_link: Option<LinkFactory>,
}

pub struct UsageService {
    deps: UsageServiceDeps,
    inner: Mutex<InnerState>,
    view_queue: Mutex<()>,
    logout_queue: Mutex<()>,
}

impl UsageService {
    pub fn new(deps: UsageServiceDeps) -> Arc<Self> {
        Arc::new(Self {
            deps,
            inner: Mutex::new(InnerState {
                snapshot: Snapshot::initial(),
                tokens: None,
                epoch: 0,
                fresh_at_ms: 0.0,
                pending_login: None,
                code_sent_to: None,
                code_after_ms: 0.0,
                link: None,
                sso_cancel: None,
                action_running: false,
                logout_running: false,
                refresh_waiters: Vec::new(),
                token_waiters: Vec::new(),
            }),
            view_queue: Mutex::new(()),
            logout_queue: Mutex::new(()),
        })
    }

    pub async fn snapshot(&self) -> Snapshot {
        self.inner.lock().await.snapshot.clone()
    }

    fn emit_snapshot(&self, snapshot: Snapshot) {
        (self.deps.publish)(snapshot);
    }

    pub async fn restore(&self) {
        let loaded = self.deps.store.load().await;
        let snapshot = {
            let mut guard = self.inner.lock().await;
            match loaded {
                Ok(Some(tokens)) => {
                    let owner_id = tokens.membership.id.clone();
                    guard.tokens = Some(tokens);
                    guard.snapshot.signed_in = true;
                    drop(guard);
                    let view = self.deps.store.load_view().await.ok().flatten();
                    let mut guard = self.inner.lock().await;
                    if let Some(v) = view {
                        if v.owner_id == owner_id {
                            guard.snapshot.selected_device_ids = v.device_ids;
                            guard.snapshot.device_order = v.device_order;
                        }
                    }
                    guard.snapshot.clone()
                }
                Ok(None) => {
                    guard.tokens = None;
                    guard.snapshot.signed_in = false;
                    guard.snapshot.clone()
                }
                Err(_) => {
                    guard.snapshot.error =
                        Some("无法恢复登录。请解锁钥匙串后重新打开，或退出登录清除本机记录。".to_string());
                    guard.snapshot.clone()
                }
            }
        };
        self.emit_snapshot(snapshot);
    }

    pub async fn dispose(&self) {
        let mut guard = self.inner.lock().await;
        guard.epoch += 1;
        if let Some(cancel) = guard.sso_cancel.take() {
            let _ = cancel.send(true);
        }
        if let Some(link) = guard.link.take() {
            link.stop();
        }
    }

    async fn check_epoch(&self, epoch: u64) -> Result<(), String> {
        if self.inner.lock().await.epoch != epoch {
            return Err("操作已取消".to_string());
        }
        Ok(())
    }

    pub async fn access_token(self: &Arc<Self>) -> Result<Option<String>, String> {
        let (epoch, refresh_token, mut waiter_rx) = {
            let mut guard = self.inner.lock().await;
            if guard.logout_running {
                return Ok(None);
            }
            let Some(tokens) = guard.tokens.as_ref() else {
                return Ok(None);
            };
            if now_ms() - guard.fresh_at_ms < TOKEN_FRESH_MS && guard.fresh_at_ms > 0.0 {
                return Ok(Some(tokens.access_token.clone()));
            }
            let current_refresh = tokens.refresh_token.clone();
            if !guard.token_waiters.is_empty() {
                let (tx, rx) = watch::channel(Ok(None));
                guard.token_waiters.push(tx);
                (guard.epoch, String::new(), Some(rx))
            } else {
                let (tx, _rx) = watch::channel(Ok(None));
                guard.token_waiters.push(tx);
                (guard.epoch, current_refresh, None)
            }
        };

        if let Some(ref mut rx) = waiter_rx {
            let _ = rx.changed().await;
            return rx.borrow().clone();
        }

        let result = self.refresh_token_once(epoch, &refresh_token).await;
        let waiters = {
            let mut guard = self.inner.lock().await;
            std::mem::take(&mut guard.token_waiters)
        };
        for tx in waiters {
            let _ = tx.send(result.clone());
        }
        result
    }

    async fn refresh_token_once(
        self: &Arc<Self>,
        epoch: u64,
        refresh_token: &str,
    ) -> Result<Option<String>, String> {
        match self.deps.auth.refresh(refresh_token).await {
            Ok(next) => {
                self.check_epoch(epoch).await?;
                self.deps.store.save(Some(next.clone())).await?;
                let mut guard = self.inner.lock().await;
                if guard.epoch != epoch {
                    return Err("操作已取消".to_string());
                }
                let access = next.access_token.clone();
                guard.tokens = Some(next);
                guard.fresh_at_ms = now_ms();
                Ok(Some(access))
            }
            Err(err) => {
                let is_revoked = err.status_code == 401
                    || matches!(err.code.as_str(), "INVALID_REFRESH_TOKEN" | "SESSION_REVOKED");
                let same_epoch = self.inner.lock().await.epoch == epoch;
                if same_epoch && is_revoked {
                    self.logout().await?;
                    let snap = {
                        let mut guard = self.inner.lock().await;
                        guard.snapshot.error = Some("登录已过期，请重新登录".to_string());
                        guard.snapshot.clone()
                    };
                    self.emit_snapshot(snap);
                }
                Err(friendly_auth_error(&err, "刷新失败，请检查网络或远端连接"))
            }
        }
    }

    async fn connect_link(self: &Arc<Self>, epoch: u64) -> Result<Arc<dyn DeviceLinkSession>, String> {
        let link = {
            let mut guard = self.inner.lock().await;
            if guard.epoch != epoch {
                return Err("操作已取消".to_string());
            }
            if let Some(existing) = guard.link.as_ref() {
                existing.clone()
            } else {
                let weak = Arc::downgrade(self);
                let provider: TokenProvider = Arc::new(move || {
                    let weak = weak.clone();
                    Box::pin(async move {
                        let Some(svc) = weak.upgrade() else {
                            return Ok(None);
                        };
                        svc.access_token().await
                    })
                });
                let created: Arc<dyn DeviceLinkSession> = if let Some(factory) = &self.deps.create_link {
                    factory(provider)
                } else {
                    let ws_url = format!(
                        "{}/api/device-link/ws",
                        self.deps
                            .device_link_base_url
                            .trim_end_matches('/')
                            .replacen("https://", "wss://", 1)
                            .replacen("http://", "ws://", 1)
                    );
                    Arc::new(WsDeviceLinkClient::start(ws_url, provider))
                };
                guard.link = Some(created.clone());
                created
            }
        };
        link.wait_until_online(Duration::from_secs(15)).await?;
        self.check_epoch(epoch).await?;
        Ok(link)
    }

    pub async fn refresh(self: &Arc<Self>) {
        let (epoch, mut waiter_rx) = {
            let mut guard = self.inner.lock().await;
            if guard.tokens.is_none() || guard.logout_running {
                return;
            }
            if !guard.refresh_waiters.is_empty() {
                let (tx, rx) = watch::channel(());
                guard.refresh_waiters.push(tx);
                (guard.epoch, Some(rx))
            } else {
                let (tx, _rx) = watch::channel(());
                guard.refresh_waiters.push(tx);
                guard.snapshot.busy = true;
                guard.snapshot.error = None;
                let snap = guard.snapshot.clone();
                drop(guard);
                self.emit_snapshot(snap);
                let epoch = self.inner.lock().await.epoch;
                (epoch, None)
            }
        };

        if let Some(ref mut rx) = waiter_rx {
            let _ = rx.changed().await;
            return;
        }

        let res = self.refresh_now(epoch).await;
        let (maybe_snap, waiters) = {
            let mut guard = self.inner.lock().await;
            let waiters = std::mem::take(&mut guard.refresh_waiters);
            let snap = if guard.epoch == epoch {
                if let Err(err_msg) = res {
                    guard.snapshot.error = Some(friendly_message(&err_msg, "刷新失败，请检查网络或远端连接"));
                }
                guard.snapshot.busy = false;
                Some(guard.snapshot.clone())
            } else {
                None
            };
            (snap, waiters)
        };
        if let Some(snap) = maybe_snap {
            self.emit_snapshot(snap);
        }
        for tx in waiters {
            let _ = tx.send(());
        }
    }

    async fn refresh_now(self: &Arc<Self>, epoch: u64) -> Result<(), String> {
        let Some(token) = self.access_token().await? else {
            return Err("操作已取消".to_string());
        };
        self.check_epoch(epoch).await?;

        let raw_devices = self
            .deps
            .auth
            .list_devices(&self.deps.device_link_base_url, &token)
            .await?;
        let parsed = parse_devices(&raw_devices, &self.deps.device_id)?;

        let targets: Vec<String> = {
            let mut guard = self.inner.lock().await;
            if guard.epoch != epoch {
                return Err("操作已取消".to_string());
            }
            let old: HashMap<String, (Vec<Account>, Option<f64>)> = guard
                .snapshot
                .devices
                .iter()
                .map(|d| (d.device_id.clone(), (d.accounts.clone(), d.checked_at)))
                .collect();
            let valid_ids: HashSet<&str> = parsed.iter().map(|d| d.device_id.as_str()).collect();
            guard
                .snapshot
                .selected_device_ids
                .retain(|id| valid_ids.contains(id.as_str()));
            guard.snapshot.devices = parsed
                .into_iter()
                .map(|mut d| {
                    if let Some((accounts, checked_at)) = old.get(&d.device_id) {
                        d.accounts = accounts.clone();
                        d.checked_at = *checked_at;
                    }
                    d
                })
                .collect();
            let targets = guard
                .snapshot
                .devices
                .iter()
                .filter(|d| d.online && d.remote_control_enabled)
                .map(|d| d.device_id.clone())
                .collect();
            let snap = guard.snapshot.clone();
            drop(guard);
            self.emit_snapshot(snap);
            targets
        };

        if !targets.is_empty() {
            let link = self.connect_link(epoch).await?;
            for chunk in targets.chunks(3) {
                self.check_epoch(epoch).await?;
                let mut handles = Vec::with_capacity(chunk.len());
                for device_id in chunk {
                    let svc = self.clone();
                    let link = link.clone();
                    let device_id = device_id.clone();
                    handles.push(tokio::spawn(async move {
                        svc.read_single_device_quota(epoch, link, &device_id).await;
                    }));
                }
                for h in handles {
                    let _ = h.await;
                }
            }
        }

        let mut guard = self.inner.lock().await;
        if guard.epoch != epoch {
            return Err("操作已取消".to_string());
        }
        guard.snapshot.updated_at = Some(now_ms());
        Ok(())
    }

    async fn read_single_device_quota(
        self: &Arc<Self>,
        epoch: u64,
        link: Arc<dyn DeviceLinkSession>,
        device_id: &str,
    ) {
        let outcome: Result<Vec<Account>, String> = async {
            self.check_epoch(epoch).await?;
            let accepted = link.open_link(device_id, Duration::from_secs(15)).await?;
            self.check_epoch(epoch).await?;
            if !accepted
                .capabilities
                .iter()
                .any(|c| c == CAPABILITY_BACKGROUND_LINK_V1)
            {
                link.close_link(device_id, "user");
                return Err("请更新这台电脑上的 Cindy，以支持后台读取".to_string());
            }

            let invoke_read = |channel: &'static str, args: Vec<Value>| {
                let svc = self.clone();
                let link = link.clone();
                let target = device_id.to_string();
                async move {
                    svc.check_epoch(epoch).await?;
                    let res = link
                        .invoke(&target, channel, args, Duration::from_secs(15))
                        .await?;
                    svc.check_epoch(epoch).await?;
                    match res {
                        InvokeOutcome::Ok(val) => Ok(val),
                        InvokeOutcome::Err { .. } => {
                            Err("电脑未返回额度，请检查远程权限和版本".to_string())
                        }
                    }
                }
            };

            let raw_providers = invoke_read("maker:provider:list", Vec::new()).await?;
            let providers = subscription_providers(&raw_providers)?;
            let mut accounts = Vec::with_capacity(providers.len());
            let mut tasks = Vec::with_capacity(providers.len());

            for p in providers {
                let base = empty_account(&p);
                let builtin = match base.service {
                    ServiceKind::Claude => "anthropic",
                    ServiceKind::ChatGPT => "openai",
                };
                let args = if base.id != builtin {
                    vec![json!(base.id)]
                } else if base.service == ServiceKind::Claude {
                    vec![json!(base.id), json!(false), json!(DEFAULT_ACCOUNT_USAGE_SCOPE)]
                } else {
                    vec![json!(base.id), json!(DEFAULT_ACCOUNT_USAGE_SCOPE)]
                };
                let channel = match base.service {
                    ServiceKind::Claude => "maker:usage:claude-subscription",
                    ServiceKind::ChatGPT => "maker:usage:codex-rate-limits",
                };
                let fut = invoke_read(channel, args);
                tasks.push(async move {
                    match fut.await {
                        Ok(payload) => parse_account(&p, &payload, now_ms()).unwrap_or(Account {
                            failed: true,
                            ..base
                        }),
                        Err(_) => Account {
                            failed: true,
                            ..base
                        },
                    }
                });
            }

            for t in tasks {
                accounts.push(t.await);
            }
            self.check_epoch(epoch).await?;
            accounts.sort_by_key(|a| a.service != ServiceKind::Claude);
            Ok(accounts)
        }
        .await;

        let maybe_snap = {
            let mut guard = self.inner.lock().await;
            if guard.epoch != epoch {
                return;
            }
            if let Some(dev) = guard
                .snapshot
                .devices
                .iter_mut()
                .find(|d| d.device_id == device_id)
            {
                match outcome {
                    Ok(accounts) => {
                        dev.accounts = accounts;
                        dev.checked_at = Some(now_ms());
                        dev.error = None;
                    }
                    Err(msg) => {
                        dev.error = Some(if msg == "请更新这台电脑上的 Cindy，以支持后台读取" {
                            msg
                        } else {
                            "暂时读不到这台电脑的额度".to_string()
                        });
                    }
                }
            }
            Some(guard.snapshot.clone())
        };
        if let Some(snap) = maybe_snap {
            self.emit_snapshot(snap);
        }
    }

    pub async fn logout(&self) -> Result<(), String> {
        let _logout_guard = self.logout_queue.lock().await;
        {
            let mut guard = self.inner.lock().await;
            guard.logout_running = true;
            guard.epoch += 1;
            if let Some(cancel) = guard.sso_cancel.take() {
                let _ = cancel.send(true);
            }
            if let Some(link) = guard.link.take() {
                link.stop();
            }
            guard.action_running = false;
            guard.pending_login = None;
            guard.code_sent_to = None;
            guard.snapshot.devices.clear();
            guard.snapshot.updated_at = None;
        }

        let save_res = self.deps.store.save(None).await;
        let mut guard = self.inner.lock().await;
        guard.logout_running = false;
        if let Err(e) = save_res {
            return Err(e);
        }
        guard.tokens = None;
        guard.fresh_at_ms = 0.0;
        guard.snapshot = Snapshot::initial();
        let snap = guard.snapshot.clone();
        drop(guard);
        self.emit_snapshot(snap);
        Ok(())
    }

    async fn accept_login_outcome(&self, outcome: LoginOutcome, epoch: u64) -> Result<(), String> {
        self.check_epoch(epoch).await?;
        match outcome {
            LoginOutcome::Ok(tokens) => {
                self.deps.store.save(Some(tokens.clone())).await?;
                let mut guard = self.inner.lock().await;
                if guard.epoch != epoch {
                    return Err("操作已取消".to_string());
                }
                guard.tokens = Some(tokens);
                guard.fresh_at_ms = now_ms();
                guard.pending_login = None;
                guard.code_sent_to = None;
                guard.snapshot.signed_in = true;
                guard.snapshot.login = LoginView::Idle;
                Ok(())
            }
            LoginOutcome::SelectAccount { ref accounts, .. } => {
                let choices = accounts
                    .iter()
                    .map(|a| LoginChoice {
                        id: a.id.clone(),
                        name: if a.display_name.is_empty() {
                            a.id.clone()
                        } else {
                            a.display_name.clone()
                        },
                    })
                    .collect();
                let mut guard = self.inner.lock().await;
                if guard.epoch != epoch {
                    return Err("操作已取消".to_string());
                }
                guard.pending_login = Some(outcome);
                guard.snapshot.login = LoginView::Accounts { choices };
                Ok(())
            }
            LoginOutcome::SsoVerificationRequired { ref target_masked, .. } => {
                let target = target_masked.clone();
                let mut guard = self.inner.lock().await;
                if guard.epoch != epoch {
                    return Err("操作已取消".to_string());
                }
                guard.pending_login = Some(outcome);
                guard.snapshot.login = LoginView::Verification { target };
                Ok(())
            }
            LoginOutcome::BindingRequired => {
                Err("此账号需要绑定手机号或邮箱，请先在 Cindy 完成绑定".to_string())
            }
        }
    }

    async fn run_sso_flow(&self, connection_id: &str, epoch: u64) -> Result<(), String> {
        let cancel_rx = {
            let mut guard = self.inner.lock().await;
            if guard.epoch != epoch {
                return Err("操作已取消".to_string());
            }
            let (tx, rx) = watch::channel(false);
            guard.sso_cancel = Some(tx);
            guard.snapshot.login = LoginView::Browser;
            let snap = guard.snapshot.clone();
            drop(guard);
            self.emit_snapshot(snap);
            rx
        };
        let outcome = login_sso(self.deps.auth.as_ref(), connection_id, cancel_rx, &self.deps.open_url).await?;
        self.accept_login_outcome(outcome, epoch).await
    }

    pub async fn command(self: &Arc<Self>, cmd: Command) -> Snapshot {
        if cmd == Command::State {
            return self.snapshot().await;
        }
        if self.inner.lock().await.logout_running && cmd != Command::Logout {
            return self.snapshot().await;
        }
        if matches!(cmd, Command::Cancel | Command::Logout) {
            let signed_in = self.inner.lock().await.snapshot.signed_in;
            if cmd == Command::Logout || !signed_in {
                if self.logout().await.is_err() {
                    let snap = {
                        let mut guard = self.inner.lock().await;
                        guard.snapshot.error =
                            Some("无法清除本机登录记录，请重试退出登录".to_string());
                        guard.snapshot.busy = false;
                        guard.snapshot.clone()
                    };
                    self.emit_snapshot(snap);
                }
            }
            return self.snapshot().await;
        }
        if cmd == Command::Refresh {
            self.refresh().await;
            return self.snapshot().await;
        }
        if let Command::SelectDevices { ref device_ids } | Command::ReorderDevices { ref device_ids } = cmd {
            let is_select = matches!(cmd, Command::SelectDevices { .. });
            let requested = dedup_preserve_order(device_ids);
            let _view_lock = self.view_queue.lock().await;
            let (owner_id, epoch, next_view) = {
                let guard = self.inner.lock().await;
                let Some(tokens) = guard.tokens.as_ref() else {
                    return guard.snapshot.clone();
                };
                let known: HashSet<&str> = guard
                    .snapshot
                    .devices
                    .iter()
                    .map(|d| d.device_id.as_str())
                    .collect();
                if !requested.iter().all(|id| known.contains(id.as_str())) {
                    return guard.snapshot.clone();
                }
                let next_selected = if is_select {
                    requested.clone()
                } else {
                    guard.snapshot.selected_device_ids.clone()
                };
                let next_order = if is_select {
                    guard.snapshot.device_order.clone()
                } else {
                    requested.clone()
                };
                let owner_id = tokens.membership.id.clone();
                (
                    owner_id.clone(),
                    guard.epoch,
                    SavedView {
                        owner_id,
                        device_ids: next_selected,
                        device_order: next_order,
                    },
                )
            };
            let save_res = self.deps.store.save_view(next_view.clone()).await;
            let maybe_snap = {
                let mut guard = self.inner.lock().await;
                if guard.epoch == epoch {
                    match save_res {
                        Ok(()) => {
                            let live_ids: HashSet<String> = guard
                                .snapshot
                                .devices
                                .iter()
                                .map(|d| d.device_id.clone())
                                .collect();
                            let candidate_selected = if is_select {
                                next_view.device_ids
                            } else {
                                guard.snapshot.selected_device_ids.clone()
                            };
                            guard.snapshot.selected_device_ids = candidate_selected
                                .into_iter()
                                .filter(|id| live_ids.contains(id))
                                .collect();
                            guard.snapshot.device_order = next_view.device_order;
                            guard.snapshot.error = None;
                            Some(guard.snapshot.clone())
                        }
                        Err(_) => {
                            guard.snapshot.error =
                                Some("无法保存电脑选择或顺序，请重试".to_string());
                            Some(guard.snapshot.clone())
                        }
                    }
                } else {
                    None
                }
            };
            let _ = owner_id;
            if let Some(snap) = maybe_snap {
                self.emit_snapshot(snap);
            }
            return self.snapshot().await;
        }

        let epoch = {
            let mut guard = self.inner.lock().await;
            if guard.action_running || guard.snapshot.signed_in {
                return guard.snapshot.clone();
            }
            guard.action_running = true;
            guard.snapshot.busy = true;
            guard.snapshot.error = None;
            let epoch = guard.epoch;
            let snap = guard.snapshot.clone();
            drop(guard);
            self.emit_snapshot(snap);
            epoch
        };

        let action_res: Result<(), String> = async {
            match cmd {
                Command::Sso { org } => {
                    let discovery = self
                        .deps
                        .auth
                        .discover_sso_org(org.trim())
                        .await
                        .map_err(|e| friendly_auth_error(&e, "登录未完成，请检查网络或登录信息"))?;
                    self.check_epoch(epoch).await?;
                    if discovery.connections.len() == 1 {
                        self.run_sso_flow(&discovery.connections[0].connection_id, epoch)
                            .await?;
                    } else {
                        let choices = discovery
                            .connections
                            .into_iter()
                            .map(|c| LoginChoice {
                                id: c.connection_id,
                                name: c.connection_name,
                            })
                            .collect();
                        let mut guard = self.inner.lock().await;
                        if guard.epoch == epoch {
                            guard.snapshot.login = LoginView::Connections { choices };
                        }
                    }
                }
                Command::Connection { id } => {
                    let valid = {
                        let guard = self.inner.lock().await;
                        match &guard.snapshot.login {
                            LoginView::Connections { choices } => choices.iter().any(|c| c.id == id),
                            _ => false,
                        }
                    };
                    if valid {
                        self.run_sso_flow(&id, epoch).await?;
                    }
                }
                Command::Account { id } => {
                    let ticket = {
                        let guard = self.inner.lock().await;
                        match &guard.pending_login {
                            Some(LoginOutcome::SelectAccount {
                                login_ticket,
                                accounts,
                            }) if accounts.iter().any(|a| a.id == id) => Some(login_ticket.clone()),
                            Some(LoginOutcome::SelectAccount { .. }) => {
                                return Err("无效账号".to_string());
                            }
                            _ => None,
                        }
                    };
                    if let Some(login_ticket) = ticket {
                        let outcome = self
                            .deps
                            .auth
                            .select_account(&login_ticket, &id)
                            .await
                            .map_err(|e| friendly_auth_error(&e, "登录未完成，请检查网络或登录信息"))?;
                        self.accept_login_outcome(outcome, epoch).await?;
                    }
                }
                Command::SsoSendCode => {
                    let ticket = {
                        let guard = self.inner.lock().await;
                        if now_ms() < guard.code_after_ms {
                            return Err("请稍后再获取验证码".to_string());
                        }
                        match &guard.pending_login {
                            Some(LoginOutcome::SsoVerificationRequired {
                                verification_ticket,
                                ..
                            }) => Some(verification_ticket.clone()),
                            _ => None,
                        }
                    };
                    if let Some(t) = ticket {
                        self.deps
                            .auth
                            .request_sso_verification_code(&t)
                            .await
                            .map_err(|e| friendly_auth_error(&e, "登录未完成，请检查网络或登录信息"))?;
                        let mut guard = self.inner.lock().await;
                        if guard.epoch == epoch {
                            guard.code_after_ms = now_ms() + 60_000.0;
                        }
                    }
                }
                Command::SsoVerify { code } => {
                    let ticket = {
                        let guard = self.inner.lock().await;
                        match &guard.pending_login {
                            Some(LoginOutcome::SsoVerificationRequired {
                                verification_ticket,
                                ..
                            }) => Some(verification_ticket.clone()),
                            _ => None,
                        }
                    };
                    if let Some(t) = ticket {
                        let outcome = self
                            .deps
                            .auth
                            .verify_sso_verification(&t, code.trim())
                            .await
                            .map_err(|e| friendly_auth_error(&e, "登录未完成，请检查网络或登录信息"))?;
                        self.accept_login_outcome(outcome, epoch).await?;
                    }
                }
                Command::SendCode { identifier } => {
                    {
                        let guard = self.inner.lock().await;
                        if now_ms() < guard.code_after_ms {
                            return Err("请稍后再获取验证码".to_string());
                        }
                    }
                    let id = identifier.trim().to_string();
                    let kind = if id.contains('@') { "email" } else { "phone" };
                    self.deps
                        .auth
                        .request_code(kind, &id)
                        .await
                        .map_err(|e| friendly_auth_error(&e, "登录未完成，请检查网络或登录信息"))?;
                    let mut guard = self.inner.lock().await;
                    if guard.epoch == epoch {
                        guard.code_sent_to = Some(id);
                        guard.code_after_ms = now_ms() + 60_000.0;
                    }
                }
                Command::VerifyCode { identifier, code } => {
                    let id = identifier.trim().to_string();
                    let matches_sent = {
                        let guard = self.inner.lock().await;
                        guard.code_sent_to.as_deref() == Some(id.as_str())
                    };
                    if !matches_sent {
                        return Err("请先获取验证码".to_string());
                    }
                    let kind = if id.contains('@') { "email" } else { "phone" };
                    let outcome = self
                        .deps
                        .auth
                        .verify_code(kind, &id, code.trim())
                        .await
                        .map_err(|e| friendly_auth_error(&e, "登录未完成，请检查网络或登录信息"))?;
                    self.accept_login_outcome(outcome, epoch).await?;
                }
                _ => {}
            }
            Ok(())
        }
        .await;

        let (maybe_snap, trigger_refresh) = {
            let mut guard = self.inner.lock().await;
            guard.action_running = false;
            if guard.epoch == epoch {
                if let Err(err_msg) = action_res {
                    guard.snapshot.error =
                        Some(friendly_message(&err_msg, "登录未完成，请检查网络或登录信息"));
                    if guard.snapshot.login == LoginView::Browser {
                        guard.snapshot.login = LoginView::Idle;
                    }
                }
                guard.snapshot.busy = false;
                let signed_in = guard.snapshot.signed_in;
                (Some(guard.snapshot.clone()), signed_in)
            } else {
                (None, false)
            }
        };
        if let Some(snap) = maybe_snap {
            self.emit_snapshot(snap);
        }
        if trigger_refresh {
            let svc = self.clone();
            tokio::spawn(async move {
                svc.refresh().await;
            });
        }
        self.snapshot().await
    }
}

fn dedup_preserve_order(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if seen.insert(id.clone()) {
            out.push(id.clone());
        }
    }
    out
}

fn friendly_auth_error(err: &AuthApiError, fallback: &str) -> String {
    match err.code.as_str() {
        "ORG_SSO_NOT_FOUND" => "未找到企业 SSO，请检查企业标识".to_string(),
        "INVALID_CODE" => "验证码不正确或已过期".to_string(),
        "RATE_LIMITED" => "请求过于频繁，请稍后再试".to_string(),
        "CAPTCHA_REQUIRED" => "当前登录需要人机验证，请使用企业 SSO".to_string(),
        "REGION_MISMATCH" => "此企业不在中国大陆版服务中".to_string(),
        _ => fallback.to_string(),
    }
}

fn friendly_message(msg: &str, fallback: &str) -> String {
    const SAFE_MESSAGES: &[&str] = &[
        "操作已取消",
        "登录已取消",
        "登录已超时，请重新登录",
        "企业授权未完成，请重新登录",
        "SSO 连接中断，请重新登录",
        "请先获取验证码",
        "请稍后再获取验证码",
        "登录验证失败，请重新登录",
        "电脑列表读取失败，请检查网络",
        "此账号需要绑定手机号或邮箱，请先在 Cindy 完成绑定",
        "钥匙串不可用，无法安全保存登录",
        "未找到企业 SSO，请检查企业标识",
        "验证码不正确或已过期",
        "请求过于频繁，请稍后再试",
        "当前登录需要人机验证，请使用企业 SSO",
        "此企业不在中国大陆版服务中",
    ];
    if SAFE_MESSAGES.contains(&msg) {
        msg.to_string()
    } else {
        fallback.to_string()
    }
}
