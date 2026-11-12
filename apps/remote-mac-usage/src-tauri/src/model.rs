use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

pub const CODEX_DEFAULT_LIMIT_BUCKET: &str = "__default__";
pub const STALE_BUCKET_GRACE_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const UNSAFE_BUCKET_KEYS: &[&str] = &["__proto__", "constructor", "prototype"];
const GENERIC_BUCKET_KEYS_BY_PRIORITY: &[&str] = &["codex", CODEX_DEFAULT_LIMIT_BUCKET];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub minutes: Option<i64>,
    pub remaining: f64,
    pub resets_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServiceKind {
    Claude,
    ChatGPT,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub service: ServiceKind,
    pub plan: String,
    pub windows: Vec<Quota>,
    pub updated_at: Option<f64>,
    pub failed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub name: String,
    pub online: bool,
    pub remote_control_enabled: bool,
    pub platform: String,
    pub accounts: Vec<Account>,
    pub error: Option<String>,
    pub checked_at: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginChoice {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LoginView {
    Idle,
    Browser,
    Connections { choices: Vec<LoginChoice> },
    Accounts { choices: Vec<LoginChoice> },
    Verification { target: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub signed_in: bool,
    pub busy: bool,
    pub error: Option<String>,
    pub login: LoginView,
    pub devices: Vec<Device>,
    pub updated_at: Option<f64>,
    pub demo: bool,
    pub selected_device_ids: Vec<String>,
    pub device_order: Vec<String>,
}

impl Snapshot {
    pub fn initial() -> Self {
        Self {
            signed_in: false,
            busy: false,
            error: None,
            login: LoginView::Idle,
            devices: Vec::new(),
            updated_at: None,
            demo: false,
            selected_device_ids: Vec::new(),
            device_order: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    State,
    Refresh,
    Cancel,
    Logout,
    Hide,
    Quit,
    Sso { org: String },
    Connection { id: String },
    Account { id: String },
    SendCode { identifier: String },
    VerifyCode { identifier: String, code: String },
    SsoSendCode,
    SsoVerify { code: String },
    SelectDevices { device_ids: Vec<String> },
    ReorderDevices { device_ids: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn bounded_text(value: Option<&Value>, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some(s) => s.chars().take(200).collect(),
        None => fallback.to_string(),
    }
}

fn positive_timestamp(value: Option<&Value>) -> Option<f64> {
    finite_number(value).filter(|&n| n > 0.0)
}

pub fn parse_devices(raw: &Value, self_id: &str) -> Result<Vec<Device>, String> {
    let list = raw
        .as_object()
        .and_then(|o| o.get("devices"))
        .and_then(Value::as_array)
        .ok_or_else(|| "电脑列表格式不正确".to_string())?;

    let mut out = Vec::new();
    for item in list {
        let Some(d) = item.as_object() else { continue };
        let Some(device_id) = d.get("deviceId").and_then(Value::as_str) else {
            continue;
        };
        let platform_raw = d.get("platform").and_then(Value::as_str).unwrap_or("");
        if device_id == self_id
            || device_id.starts_with("quota-cat-")
            || matches!(platform_raw, "ios" | "android")
        {
            continue;
        }
        let online = d.get("online").and_then(Value::as_bool) == Some(true);
        let remote_control_enabled = d.get("remoteControlEnabled").and_then(Value::as_bool)
            == Some(true)
            && d.get("controlEnabled").and_then(Value::as_bool) != Some(false);
        out.push(Device {
            device_id: device_id.to_string(),
            name: bounded_text(d.get("name"), "未命名电脑"),
            platform: bounded_text(d.get("platform"), ""),
            online,
            remote_control_enabled,
            accounts: Vec::new(),
            error: None,
            checked_at: None,
        });
    }
    Ok(out)
}

pub fn subscription_providers(raw: &Value) -> Result<Vec<Map<String, Value>>, String> {
    let providers = raw
        .as_object()
        .and_then(|o| o.get("providers"))
        .and_then(Value::as_array)
        .ok_or_else(|| "电脑未返回账号列表".to_string())?;

    let mut out = Vec::new();
    for value in providers {
        let Some(p) = value.as_object() else { continue };
        let connected = p.get("connected").and_then(Value::as_bool) == Some(true);
        let removed = p.get("removed").and_then(Value::as_bool).unwrap_or(false);
        let suspended = p.get("suspended").and_then(Value::as_bool).unwrap_or(false);
        let Some(id) = p.get("id").and_then(Value::as_str) else {
            continue;
        };
        let auth = p.get("auth").and_then(Value::as_object);
        let is_oauth = auth.and_then(|a| a.get("method")).and_then(Value::as_str) == Some("oauth");
        let access_ok = match p.get("access") {
            None | Some(Value::Null) => true,
            Some(v) => {
                v.as_object()
                    .and_then(|a| a.get("kind"))
                    .and_then(Value::as_str)
                    == Some("subscription")
            }
        };
        let native = auth
            .and_then(|a| a.get("native"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let supported = matches!(native, "claude" | "codex") || matches!(id, "anthropic" | "openai");
        if connected && !removed && !suspended && is_oauth && access_ok && supported {
            out.push(p.clone());
        }
    }
    Ok(out)
}

pub fn empty_account(p: &Map<String, Value>) -> Account {
    let native = p
        .get("auth")
        .and_then(Value::as_object)
        .and_then(|a| a.get("native"))
        .and_then(Value::as_str);
    let id = p
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let openai = native == Some("codex") || id == "openai";
    Account {
        id,
        name: bounded_text(p.get("name"), if openai { "ChatGPT" } else { "Claude" }),
        service: if openai {
            ServiceKind::ChatGPT
        } else {
            ServiceKind::Claude
        },
        plan: String::new(),
        windows: Vec::new(),
        updated_at: None,
        failed: false,
    }
}

pub fn is_codex_bucket_stale(bucket: &Map<String, Value>, current_ms: f64) -> bool {
    let mut windows = Vec::new();
    for key in ["primary", "secondary"] {
        if let Some(w) = bucket.get(key).and_then(Value::as_object) {
            windows.push(w);
        }
    }
    if windows.is_empty() {
        return false;
    }
    let mut max_reset: Option<f64> = None;
    for w in &windows {
        let Some(r) = positive_timestamp(w.get("resetsAt")) else {
            // Missing resetsAt on any window -> conservatively not stale.
            return false;
        };
        max_reset = Some(max_reset.map_or(r, |prev| prev.max(r)));
    }
    match max_reset {
        Some(r) => r * 1000.0 + STALE_BUCKET_GRACE_MS < current_ms,
        None => false,
    }
}

fn read_bucket_table(value: Option<&Value>) -> Option<Vec<(String, Map<String, Value>)>> {
    let obj = value?.as_object()?;
    let mut out = Vec::new();
    for (k, v) in obj {
        if UNSAFE_BUCKET_KEYS.contains(&k.as_str()) {
            continue;
        }
        if let Some(entry) = v.as_object() {
            out.push((k.clone(), entry.clone()));
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn normalize_model_token(value: Option<&str>) -> String {
    value
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

pub fn select_codex_usage_for_model(
    fallback: Option<&Value>,
    by_limit_id: Option<&Value>,
    app_server_buckets: Option<&Value>,
    model_id: Option<&str>,
    current_ms: f64,
) -> Option<Map<String, Value>> {
    let table = read_bucket_table(by_limit_id).or_else(|| read_bucket_table(app_server_buckets));
    let Some(buckets) = table else {
        return fallback.and_then(Value::as_object).cloned();
    };
    let live: Vec<(String, Map<String, Value>)> = buckets
        .into_iter()
        .filter(|(_, b)| !is_codex_bucket_stale(b, current_ms))
        .collect();
    if live.is_empty() {
        return None;
    }
    let model = normalize_model_token(model_id);
    if !model.is_empty() {
        let mut longest: Option<(usize, Map<String, Value>)> = None;
        for (_, b) in &live {
            let name = normalize_model_token(b.get("limitName").and_then(Value::as_str));
            if name.is_empty() {
                continue;
            }
            if name == model {
                return Some(b.clone());
            }
            if model.contains(&name)
                && longest.as_ref().map_or(true, |(len, _)| name.len() > *len)
            {
                longest = Some((name.len(), b.clone()));
            }
        }
        if let Some((_, matched)) = longest {
            return Some(matched);
        }
    }
    for &priority_key in GENERIC_BUCKET_KEYS_BY_PRIORITY {
        if let Some((_, found)) = live.iter().find(|(k, _)| k == priority_key) {
            return Some(found.clone());
        }
    }
    None
}

pub fn parse_account(p: &Map<String, Value>, payload: &Value, current_ms: f64) -> Result<Account, String> {
    let mut a = empty_account(p);
    let empty_map = Map::new();
    let raw = payload.as_object().unwrap_or(&empty_map);
    let builtin = match a.service {
        ServiceKind::Claude => "anthropic",
        ServiceKind::ChatGPT => "openai",
    };
    let resp_provider_id = raw.get("providerId");
    let has_provider_id = resp_provider_id.is_some() && !resp_provider_id.unwrap().is_null();
    let matches_id = resp_provider_id.and_then(Value::as_str) == Some(a.id.as_str());
    if (has_provider_id && !matches_id) || (a.id != builtin && !matches_id) {
        return Err("远端版本无法区分这个独立账号，请更新远端 Cindy".to_string());
    }

    let mut add = |used: Option<&Value>, minutes: Option<i64>, reset: Option<&Value>, label: Option<String>| {
        let Some(used_val) = finite_number(used) else {
            return;
        };
        let remaining = (100.0 - used_val).clamp(0.0, 100.0);
        a.windows.push(Quota {
            minutes,
            remaining,
            resets_at: positive_timestamp(reset),
            label,
        });
    };

    match a.service {
        ServiceKind::Claude => {
            a.plan = bounded_text(raw.get("subscriptionType"), "");
            a.updated_at = positive_timestamp(raw.get("updatedAt"));
            for (key, minutes) in [("fiveHour", 300_i64), ("sevenDay", 10080_i64)] {
                if let Some(w) = raw.get(key).and_then(Value::as_object) {
                    add(w.get("utilization"), Some(minutes), w.get("resetsAt"), None);
                }
            }
            if let Some(scoped) = raw.get("scoped").and_then(Value::as_array) {
                for item in scoped {
                    if let Some(w) = item.as_object() {
                        let label = bounded_text(w.get("modelDisplayName"), "模型专项");
                        add(w.get("utilization"), Some(10080), w.get("resetsAt"), Some(label));
                    }
                }
            }
        }
        ServiceKind::ChatGPT => {
            let selected = select_codex_usage_for_model(
                raw.get("rateLimits"),
                raw.get("rateLimitsByLimitId"),
                raw.get("appServerBuckets"),
                None,
                current_ms,
            );
            a.plan = raw
                .get("account")
                .and_then(Value::as_object)
                .map(|acc| bounded_text(acc.get("planType"), ""))
                .unwrap_or_default();
            if let Some(bucket) = selected {
                a.updated_at = positive_timestamp(bucket.get("updatedAt"));
                for key in ["primary", "secondary"] {
                    if let Some(w) = bucket.get(key).and_then(Value::as_object) {
                        let minutes = finite_number(w.get("windowMinutes"))
                            .filter(|&m| m > 0.0)
                            .map(|m| m as i64);
                        add(w.get("usedPercent"), minutes, w.get("resetsAt"), None);
                    }
                }
            }
        }
    }
    Ok(a)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn current_quota(q: Option<&Quota>, current_ms: f64) -> bool {
    match q {
        None => false,
        Some(quota) => quota.resets_at.map_or(true, |r| r * 1000.0 > current_ms),
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn missing_reset_text(q: &Quota) -> &'static str {
    if (q.remaining - 100.0).abs() < f64::EPSILON {
        "当前未使用 · 来源未返回重置时间"
    } else {
        "来源未返回重置时间"
    }
}

fn require_valid_string(obj: &Map<String, Value>, key: &str) -> Result<String, String> {
    let s = obj
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| "请填写有效的登录信息".to_string())?;
    if s.trim().is_empty() || s.chars().count() > 254 {
        return Err("请填写有效的登录信息".to_string());
    }
    Ok(s.to_string())
}

fn require_valid_device_ids(obj: &Map<String, Value>) -> Result<Vec<String>, String> {
    let arr = obj
        .get("deviceIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "请选择有效的电脑".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let Some(id) = item.as_str() else {
            return Err("请选择有效的电脑".to_string());
        };
        if id.trim().is_empty() || id.chars().count() > 254 {
            return Err("请选择有效的电脑".to_string());
        }
        out.push(id.to_string());
    }
    Ok(out)
}

fn ensure_only_keys(obj: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    for key in obj.keys() {
        if key != "kind" && !allowed.contains(&key.as_str()) {
            return Err("操作格式不正确".to_string());
        }
    }
    Ok(())
}

pub fn validate_command(value: &Value) -> Result<Command, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "操作格式不正确".to_string())?;
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "操作格式不正确".to_string())?;

    match kind {
        "state" => {
            ensure_only_keys(obj, &[])?;
            Ok(Command::State)
        }
        "refresh" => {
            ensure_only_keys(obj, &[])?;
            Ok(Command::Refresh)
        }
        "cancel" => {
            ensure_only_keys(obj, &[])?;
            Ok(Command::Cancel)
        }
        "logout" => {
            ensure_only_keys(obj, &[])?;
            Ok(Command::Logout)
        }
        "hide" => {
            ensure_only_keys(obj, &[])?;
            Ok(Command::Hide)
        }
        "quit" => {
            ensure_only_keys(obj, &[])?;
            Ok(Command::Quit)
        }
        "sso-send-code" => {
            ensure_only_keys(obj, &[])?;
            Ok(Command::SsoSendCode)
        }
        "sso" => {
            ensure_only_keys(obj, &["org"])?;
            Ok(Command::Sso {
                org: require_valid_string(obj, "org")?,
            })
        }
        "connection" => {
            ensure_only_keys(obj, &["id"])?;
            Ok(Command::Connection {
                id: require_valid_string(obj, "id")?,
            })
        }
        "account" => {
            ensure_only_keys(obj, &["id"])?;
            Ok(Command::Account {
                id: require_valid_string(obj, "id")?,
            })
        }
        "send-code" => {
            ensure_only_keys(obj, &["identifier"])?;
            Ok(Command::SendCode {
                identifier: require_valid_string(obj, "identifier")?,
            })
        }
        "verify-code" => {
            ensure_only_keys(obj, &["identifier", "code"])?;
            Ok(Command::VerifyCode {
                identifier: require_valid_string(obj, "identifier")?,
                code: require_valid_string(obj, "code")?,
            })
        }
        "sso-verify" => {
            ensure_only_keys(obj, &["code"])?;
            Ok(Command::SsoVerify {
                code: require_valid_string(obj, "code")?,
            })
        }
        "select-devices" => {
            ensure_only_keys(obj, &["deviceIds"])?;
            Ok(Command::SelectDevices {
                device_ids: require_valid_device_ids(obj)?,
            })
        }
        "reorder-devices" => {
            ensure_only_keys(obj, &["deviceIds"])?;
            Ok(Command::ReorderDevices {
                device_ids: require_valid_device_ids(obj)?,
            })
        }
        _ => Err("不支持的操作".to_string()),
    }
}

pub fn tray_window_position(tray: IntRect, work_area: IntRect, size: (i32, i32)) -> (i32, i32) {
    let (width, height) = size;
    let center_x = tray.x as f64 + tray.width as f64 / 2.0 - width as f64 / 2.0;
    let min_x = work_area.x as f64;
    let max_x = (work_area.x + work_area.width - width) as f64;
    let x = center_x.min(max_x).max(min_x).round() as i32;

    let desired_y = (tray.y + tray.height + 8) as f64;
    let min_y = work_area.y as f64;
    let max_y = (work_area.y + work_area.height - height) as f64;
    let y = desired_y.min(max_y).max(min_y).round() as i32;
    (x, y)
}

pub fn demo_snapshot() -> Snapshot {
    let now = now_ms();
    let reset = |hours: f64| now / 1000.0 + hours * 3600.0;
    Snapshot {
        signed_in: true,
        busy: false,
        error: None,
        demo: true,
        login: LoginView::Idle,
        updated_at: Some(now),
        selected_device_ids: Vec::new(),
        device_order: Vec::new(),
        devices: vec![
            Device {
                device_id: "demo-mbp".to_string(),
                name: "M5 MacBook Pro".to_string(),
                platform: "darwin".to_string(),
                online: true,
                remote_control_enabled: true,
                error: None,
                checked_at: Some(now),
                accounts: vec![
                    Account {
                        id: "anthropic".to_string(),
                        name: "Claude 工作账号".to_string(),
                        service: ServiceKind::Claude,
                        plan: "Max".to_string(),
                        updated_at: Some(now),
                        failed: false,
                        windows: vec![
                            Quota {
                                minutes: Some(300),
                                remaining: 68.0,
                                resets_at: Some(reset(2.3)),
                                label: None,
                            },
                            Quota {
                                minutes: Some(10080),
                                remaining: 42.0,
                                resets_at: Some(reset(51.0)),
                                label: None,
                            },
                            Quota {
                                minutes: Some(10080),
                                remaining: 73.0,
                                resets_at: Some(reset(51.0)),
                                label: Some("Sonnet".to_string()),
                            },
                        ],
                    },
                    Account {
                        id: "openai".to_string(),
                        name: "ChatGPT 个人账号".to_string(),
                        service: ServiceKind::ChatGPT,
                        plan: "Pro".to_string(),
                        updated_at: Some(now),
                        failed: false,
                        windows: vec![
                            Quota {
                                minutes: Some(300),
                                remaining: 22.0,
                                resets_at: Some(reset(3.1)),
                                label: None,
                            },
                            Quota {
                                minutes: Some(10080),
                                remaining: 76.0,
                                resets_at: Some(reset(74.0)),
                                label: None,
                            },
                        ],
                    },
                ],
            },
            Device {
                device_id: "demo-studio".to_string(),
                name: "办公室 Mac Studio".to_string(),
                platform: "darwin".to_string(),
                online: false,
                remote_control_enabled: true,
                error: None,
                checked_at: None,
                accounts: Vec::new(),
            },
        ],
    }
}
