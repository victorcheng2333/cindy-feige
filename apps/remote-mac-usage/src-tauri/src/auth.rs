use crate::storage::{AuthMembership, AuthTokenPair};
use async_trait::async_trait;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use tokio::sync::watch;
use url::Url;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AuthApiError {
    pub code: String,
    pub status_code: u16,
    pub message: String,
}

impl std::fmt::Display for AuthApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AuthApiError {}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoOrgConnection {
    pub connection_id: String,
    #[allow(dead_code)]
    pub protocol: String,
    pub connection_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoOrgDiscovery {
    pub region: String,
    #[allow(dead_code)]
    pub org_name: String,
    pub connections: Vec<SsoOrgConnection>,
}

#[derive(Debug, Clone)]
pub enum LoginOutcome {
    Ok(AuthTokenPair),
    SelectAccount {
        login_ticket: String,
        accounts: Vec<AuthMembership>,
    },
    SsoVerificationRequired {
        verification_ticket: String,
        target_masked: String,
    },
    BindingRequired,
}

#[derive(Debug, Clone)]
pub enum DesktopAuthorizationPoll {
    Pending,
    Ok { code: String },
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkceProof {
    pub verifier: String,
    pub poll_secret: String,
    pub challenge: String,
    pub state: String,
}

pub fn create_proof() -> PkceProof {
    let mut verifier_bytes = [0u8; 32];
    verifier_bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    verifier_bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());

    let mut poll_bytes = [0u8; 32];
    poll_bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    poll_bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());

    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let poll_secret = URL_SAFE_NO_PAD.encode(poll_bytes);
    let hash = |input: &str| -> String {
        let digest = Sha256::digest(input.as_bytes());
        URL_SAFE_NO_PAD.encode(digest)
    };
    let challenge = hash(&verifier);
    let state = hash(&poll_secret);
    PkceProof {
        verifier,
        poll_secret,
        challenge,
        state,
    }
}

pub fn build_sso_authorize_url(
    base_url: &str,
    device_id: &str,
    connection_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
) -> Result<String, AuthApiError> {
    let trimmed = base_url.trim_end_matches('/');
    let encoded_id: String = url::form_urlencoded::byte_serialize(connection_id.as_bytes()).collect();
    let mut url = Url::parse(&format!("{trimmed}/api/auth/sso/{encoded_id}/authorize")).map_err(|_| {
        AuthApiError {
            code: "INVALID_URL".to_string(),
            status_code: 0,
            message: "无效的登录地址".to_string(),
        }
    })?;
    url.query_pairs_mut()
        .append_pair("client_type", "desktop")
        .append_pair("device_id", device_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("client_state", state)
        .append_pair("ui_locale", "zh-CN");
    Ok(url.to_string())
}

#[async_trait]
pub trait AuthApi: Send + Sync {
    async fn discover_sso_org(&self, org: &str) -> Result<SsoOrgDiscovery, AuthApiError>;
    fn authorize_url(&self, connection_id: &str, challenge: &str, state: &str) -> Result<String, AuthApiError>;
    async fn poll_desktop_authorization(&self, poll_secret: &str) -> Result<DesktopAuthorizationPoll, AuthApiError>;
    async fn exchange_authorization_code(&self, code: &str, verifier: &str) -> Result<LoginOutcome, AuthApiError>;
    async fn select_account(&self, login_ticket: &str, account_id: &str) -> Result<LoginOutcome, AuthApiError>;
    async fn request_sso_verification_code(&self, ticket: &str) -> Result<(), AuthApiError>;
    async fn verify_sso_verification(&self, ticket: &str, code: &str) -> Result<LoginOutcome, AuthApiError>;
    async fn request_code(&self, kind: &str, identifier: &str) -> Result<(), AuthApiError>;
    async fn verify_code(&self, kind: &str, identifier: &str, code: &str) -> Result<LoginOutcome, AuthApiError>;
    async fn refresh(&self, refresh_token: &str) -> Result<AuthTokenPair, AuthApiError>;
    async fn list_devices(&self, device_link_base_url: &str, access_token: &str) -> Result<Value, String>;
}

pub struct HttpAuthClient {
    base_url: String,
    callback_url: String,
    region: String,
    device_id: String,
    http: reqwest::Client,
}

impl HttpAuthClient {
    pub fn new(base_url: &str, callback_url: &str, region: &str, device_id: &str) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client");
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            callback_url: callback_url.to_string(),
            region: region.to_string(),
            device_id: device_id.to_string(),
            http,
        }
    }

    async fn post_json(&self, path: &str, body: Value, timeout: Duration) -> Result<Value, AuthApiError> {
        let resp = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .timeout(timeout)
            .json(&body)
            .send()
            .await
            .map_err(|_| AuthApiError {
                code: "NETWORK_ERROR".to_string(),
                status_code: 0,
                message: "网络连接失败".to_string(),
            })?;

        let status = resp.status().as_u16();
        let data: Value = resp.json().await.map_err(|_| {
            if status == 429 {
                AuthApiError {
                    code: "RATE_LIMITED".to_string(),
                    status_code: 429,
                    message: "Too many requests".to_string(),
                }
            } else {
                AuthApiError {
                    code: "INVALID_RESPONSE".to_string(),
                    status_code: status,
                    message: "Invalid JSON response".to_string(),
                }
            }
        })?;

        if !(200..300).contains(&status) {
            let code = if status == 429 {
                "RATE_LIMITED".to_string()
            } else {
                data.get("error")
                    .and_then(|e| e.get("code"))
                    .and_then(Value::as_str)
                    .or_else(|| data.get("code").and_then(Value::as_str))
                    .unwrap_or("AUTH_REQUEST_FAILED")
                    .to_string()
            };
            let message = data
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .or_else(|| data.get("message").and_then(Value::as_str))
                .unwrap_or("Authentication request failed")
                .to_string();
            return Err(AuthApiError {
                code,
                status_code: status,
                message,
            });
        }
        Ok(data)
    }
}

fn parse_login_outcome(data: Value) -> Result<LoginOutcome, AuthApiError> {
    let invalid = || AuthApiError {
        code: "INVALID_RESPONSE".to_string(),
        status_code: 200,
        message: "Malformed login outcome".to_string(),
    };
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    match status {
        "ok" => {
            let pair: AuthTokenPair = serde_json::from_value(data).map_err(|_| invalid())?;
            pair.validate().map_err(|_| invalid())?;
            Ok(LoginOutcome::Ok(pair))
        }
        "select_account" => {
            let ticket = data
                .get("loginTicket")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?
                .to_string();
            let accounts_val = data.get("accounts").cloned().ok_or_else(invalid)?;
            let accounts: Vec<AuthMembership> =
                serde_json::from_value(accounts_val).map_err(|_| invalid())?;
            if accounts.is_empty() {
                return Err(invalid());
            }
            Ok(LoginOutcome::SelectAccount {
                login_ticket: ticket,
                accounts,
            })
        }
        "sso_verification_required" => {
            let ticket = data
                .get("verificationTicket")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?
                .to_string();
            let target = data
                .get("targetMasked")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Ok(LoginOutcome::SsoVerificationRequired {
                verification_ticket: ticket,
                target_masked: target,
            })
        }
        "binding_required" => Ok(LoginOutcome::BindingRequired),
        _ => Err(invalid()),
    }
}

#[async_trait]
impl AuthApi for HttpAuthClient {
    async fn discover_sso_org(&self, org: &str) -> Result<SsoOrgDiscovery, AuthApiError> {
        let data = self
            .post_json("/api/auth/sso/discovery", json!({ "org": org }), Duration::from_secs(15))
            .await?;
        let discovery: SsoOrgDiscovery = serde_json::from_value(data).map_err(|_| AuthApiError {
            code: "INVALID_RESPONSE".to_string(),
            status_code: 200,
            message: "Invalid SSO discovery response".to_string(),
        })?;
        if discovery.region != self.region {
            return Err(AuthApiError {
                code: "REGION_MISMATCH".to_string(),
                status_code: 0,
                message: "Region mismatch".to_string(),
            });
        }
        if discovery.connections.is_empty() {
            return Err(AuthApiError {
                code: "ORG_SSO_NOT_FOUND".to_string(),
                status_code: 200,
                message: "No SSO connection enabled".to_string(),
            });
        }
        Ok(discovery)
    }

    fn authorize_url(&self, connection_id: &str, challenge: &str, state: &str) -> Result<String, AuthApiError> {
        build_sso_authorize_url(
            &self.base_url,
            &self.device_id,
            connection_id,
            &self.callback_url,
            challenge,
            state,
        )
    }

    async fn poll_desktop_authorization(&self, poll_secret: &str) -> Result<DesktopAuthorizationPoll, AuthApiError> {
        let data = self
            .post_json(
                "/api/auth/desktop/callback/poll",
                json!({ "pollSecret": poll_secret, "deviceId": self.device_id }),
                Duration::from_secs(30),
            )
            .await?;
        match data.get("status").and_then(Value::as_str) {
            Some("pending") => Ok(DesktopAuthorizationPoll::Pending),
            Some("ok") => {
                let code = data
                    .get("code")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| AuthApiError {
                        code: "INVALID_RESPONSE".to_string(),
                        status_code: 200,
                        message: "Missing authorization code".to_string(),
                    })?;
                Ok(DesktopAuthorizationPoll::Ok {
                    code: code.to_string(),
                })
            }
            Some("error" | "expired") => Ok(DesktopAuthorizationPoll::Failed),
            _ => Err(AuthApiError {
                code: "INVALID_RESPONSE".to_string(),
                status_code: 200,
                message: "Unknown poll status".to_string(),
            }),
        }
    }

    async fn exchange_authorization_code(&self, code: &str, verifier: &str) -> Result<LoginOutcome, AuthApiError> {
        let data = self
            .post_json(
                "/api/auth/token",
                json!({
                    "grantType": "authorization_code",
                    "code": code,
                    "codeVerifier": verifier,
                    "deviceId": self.device_id,
                }),
                Duration::from_secs(15),
            )
            .await?;
        parse_login_outcome(data)
    }

    async fn select_account(&self, login_ticket: &str, account_id: &str) -> Result<LoginOutcome, AuthApiError> {
        let data = self
            .post_json(
                "/api/auth/select-account",
                json!({
                    "loginTicket": login_ticket,
                    "accountId": account_id,
                    "deviceId": self.device_id,
                }),
                Duration::from_secs(15),
            )
            .await?;
        parse_login_outcome(data)
    }

    async fn request_sso_verification_code(&self, ticket: &str) -> Result<(), AuthApiError> {
        self.post_json(
            "/api/auth/sso/verification/request-code",
            json!({ "verificationTicket": ticket, "deviceId": self.device_id }),
            Duration::from_secs(15),
        )
        .await?;
        Ok(())
    }

    async fn verify_sso_verification(&self, ticket: &str, code: &str) -> Result<LoginOutcome, AuthApiError> {
        let data = self
            .post_json(
                "/api/auth/sso/verification/verify",
                json!({ "verificationTicket": ticket, "code": code, "deviceId": self.device_id }),
                Duration::from_secs(15),
            )
            .await?;
        parse_login_outcome(data)
    }

    async fn request_code(&self, kind: &str, identifier: &str) -> Result<(), AuthApiError> {
        let body = if kind == "email" {
            json!({ "email": identifier, "locale": "zh-CN" })
        } else {
            json!({ "phone": identifier, "locale": "zh-CN" })
        };
        self.post_json(
            &format!("/api/auth/{kind}/request-code"),
            body,
            Duration::from_secs(15),
        )
        .await?;
        Ok(())
    }

    async fn verify_code(&self, kind: &str, identifier: &str, code: &str) -> Result<LoginOutcome, AuthApiError> {
        let body = if kind == "email" {
            json!({
                "email": identifier,
                "code": code,
                "deviceId": self.device_id,
                "clientType": "desktop",
                "locale": "zh-CN",
            })
        } else {
            json!({
                "phone": identifier,
                "code": code,
                "deviceId": self.device_id,
                "clientType": "desktop",
                "locale": "zh-CN",
            })
        };
        let data = self
            .post_json(
                &format!("/api/auth/{kind}/verify-code"),
                body,
                Duration::from_secs(15),
            )
            .await?;
        parse_login_outcome(data)
    }

    async fn refresh(&self, refresh_token: &str) -> Result<AuthTokenPair, AuthApiError> {
        let data = self
            .post_json(
                "/api/auth/refresh",
                json!({ "refreshToken": refresh_token, "deviceId": self.device_id }),
                Duration::from_secs(30),
            )
            .await?;
        let pair: AuthTokenPair = serde_json::from_value(data).map_err(|_| AuthApiError {
            code: "INVALID_RESPONSE".to_string(),
            status_code: 200,
            message: "Invalid refresh response".to_string(),
        })?;
        pair.validate().map_err(|_| AuthApiError {
            code: "INVALID_RESPONSE".to_string(),
            status_code: 200,
            message: "Invalid refresh token fields".to_string(),
        })?;
        Ok(pair)
    }

    async fn list_devices(&self, device_link_base_url: &str, access_token: &str) -> Result<Value, String> {
        let url = format!("{}/api/device-link/devices", device_link_base_url.trim_end_matches('/'));
        let resp = self
            .http
            .get(url)
            .header("Authorization", format!("Bearer {access_token}"))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| "电脑列表读取失败，请检查网络".to_string())?;
        if !resp.status().is_success() {
            return Err(if resp.status().as_u16() == 401 {
                "登录验证失败，请重新登录".to_string()
            } else {
                "电脑列表读取失败，请检查网络".to_string()
            });
        }
        resp.json::<Value>()
            .await
            .map_err(|_| "电脑列表格式不正确".to_string())
    }
}

pub type OpenUrlFn =
    Box<dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;

pub async fn login_sso(
    auth: &dyn AuthApi,
    connection_id: &str,
    mut cancel_rx: watch::Receiver<bool>,
    open_url: &OpenUrlFn,
) -> Result<LoginOutcome, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5 * 60);
    let check = |cancel_rx: &watch::Receiver<bool>| -> Result<(), String> {
        if *cancel_rx.borrow() {
            return Err("登录已取消".to_string());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("登录已超时，请重新登录".to_string());
        }
        Ok(())
    };
    let proof = create_proof();
    check(&cancel_rx)?;
    let url = auth
        .authorize_url(connection_id, &proof.challenge, &proof.state)
        .map_err(|e| e.message)?;
    open_url(url).await?;

    let mut failures = 0_u32;
    loop {
        check(&cancel_rx)?;
        let poll_res = tokio::select! {
            _ = cancel_rx.changed() => {
                return Err("登录已取消".to_string());
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err("登录已超时，请重新登录".to_string());
            }
            res = auth.poll_desktop_authorization(&proof.poll_secret) => res,
        };
        check(&cancel_rx)?;
        match poll_res {
            Ok(DesktopAuthorizationPoll::Pending) => {
                failures = 0;
            }
            Ok(DesktopAuthorizationPoll::Ok { code }) => {
                let outcome = tokio::select! {
                    _ = cancel_rx.changed() => return Err("登录已取消".to_string()),
                    _ = tokio::time::sleep_until(deadline) => return Err("登录已超时，请重新登录".to_string()),
                    out = auth.exchange_authorization_code(&code, &proof.verifier) => out.map_err(|e| e.message)?,
                };
                check(&cancel_rx)?;
                return Ok(outcome);
            }
            Ok(DesktopAuthorizationPoll::Failed) => {
                return Err("企业授权未完成，请重新登录".to_string());
            }
            Err(_) => {
                failures += 1;
                if failures >= 3 {
                    return Err("SSO 连接中断，请重新登录".to_string());
                }
            }
        }
        tokio::select! {
            _ = cancel_rx.changed() => return Err("登录已取消".to_string()),
            _ = tokio::time::sleep_until(deadline) => return Err("登录已超时，请重新登录".to_string()),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}
