use aes::Aes128;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use hmac::Hmac;
use pbkdf2::pbkdf2;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::Sha1;
use std::collections::HashSet;
use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMembership {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passport_id: Option<String>,
    pub kind: String,
    pub role: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub email: Option<String>,
    pub org_id: Option<String>,
    pub org_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_logo_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthTokenPair {
    pub access_token: String,
    pub refresh_token: String,
    pub membership: AuthMembership,
}

impl AuthTokenPair {
    pub fn validate(&self) -> Result<(), String> {
        if self.access_token.is_empty()
            || self.refresh_token.is_empty()
            || self.membership.id.is_empty()
        {
            return Err("invalid token pair".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    pub owner_id: String,
    pub device_ids: Vec<String>,
    pub device_order: Vec<String>,
}

#[async_trait]
pub trait SessionStore: Send + Sync {
    async fn load(&self) -> Result<Option<AuthTokenPair>, String>;
    async fn save(&self, value: Option<AuthTokenPair>) -> Result<(), String>;
    async fn load_view(&self) -> Result<Option<SavedView>, String>;
    async fn save_view(&self, value: SavedView) -> Result<(), String>;
}

pub trait Cipher: Send + Sync {
    fn is_encryption_available(&self) -> bool;
    fn encrypt_string(&self, text: &str) -> Result<Vec<u8>, String>;
    fn decrypt_string(&self, bytes: &[u8]) -> Result<String, String>;
}

const ENVELOPE_HEADER: &[u8] = b"qcat:v1:";
const OSCRYPT_V10_PREFIX: &[u8] = b"v10";
const OSCRYPT_SALT: &[u8] = b"saltysalt";
const OSCRYPT_MACOS_ITERATIONS: u32 = 1003;
const OSCRYPT_SPACE_IV: [u8; 16] = [b' '; 16];

/// Chromium/Electron macOS `safeStorage` v10 payload compatibility:
/// `PBKDF2-HMAC-SHA1(secret, "saltysalt", 1003, 16)` + `AES-128-CBC-PKCS7` with 16 `' '` IV, prefixed by `"v10"`.
pub fn derive_macos_oscrypt_v10_key(keychain_secret: &[u8]) -> [u8; 16] {
    let mut derived = [0u8; 16];
    let _ = pbkdf2::<Hmac<Sha1>>(keychain_secret, OSCRYPT_SALT, OSCRYPT_MACOS_ITERATIONS, &mut derived);
    derived
}

pub fn encrypt_oscrypt_v10(plaintext: &str, key: &[u8; 16]) -> Result<Vec<u8>, String> {
    type Aes128CbcEnc = cbc::Encryptor<Aes128>;
    let body = Aes128CbcEnc::new(key.into(), &OSCRYPT_SPACE_IV.into())
        .encrypt_padded_vec_mut::<Pkcs7>(plaintext.as_bytes());
    let mut out = Vec::with_capacity(OSCRYPT_V10_PREFIX.len() + body.len());
    out.extend_from_slice(OSCRYPT_V10_PREFIX);
    out.extend_from_slice(&body);
    Ok(out)
}

pub fn decrypt_oscrypt_v10(bytes: &[u8], key: &[u8; 16]) -> Result<String, String> {
    if bytes.len() <= OSCRYPT_V10_PREFIX.len() || &bytes[..OSCRYPT_V10_PREFIX.len()] != OSCRYPT_V10_PREFIX {
        return Err("不支持的 safeStorage 密文前缀".to_string());
    }
    type Aes128CbcDec = cbc::Decryptor<Aes128>;
    let mut buf = bytes[OSCRYPT_V10_PREFIX.len()..].to_vec();
    let decrypted = Aes128CbcDec::new(key.into(), &OSCRYPT_SPACE_IV.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| "无法解密 safeStorage 密文".to_string())?;
    String::from_utf8(decrypted.to_vec()).map_err(|_| "UTF-8 无效".to_string())
}

#[cfg(target_os = "macos")]
pub struct KeychainCipher {
    service: String,
    account: String,
    cached_v10_key: std::sync::Mutex<Option<[u8; 16]>>,
    cached_gcm_key: std::sync::Mutex<Option<[u8; 32]>>,
}

#[cfg(target_os = "macos")]
impl KeychainCipher {
    pub fn new(service: impl Into<String>, account: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            account: account.into(),
            cached_v10_key: std::sync::Mutex::new(None),
            cached_gcm_key: std::sync::Mutex::new(None),
        }
    }

    fn load_or_create_oscrypt_v10_key(&self, create_if_missing: bool) -> Result<[u8; 16], String> {
        if let Some(key) = *self.cached_v10_key.lock().unwrap() {
            return Ok(key);
        }
        use security_framework::passwords::{get_generic_password, set_generic_password};

        match get_generic_password(&self.service, &self.account) {
            Ok(secret_bytes) => {
                let derived = derive_macos_oscrypt_v10_key(&secret_bytes);
                *self.cached_v10_key.lock().unwrap() = Some(derived);
                Ok(derived)
            }
            Err(err) => {
                // errSecItemNotFound = -25300
                if err.code() == -25300 && create_if_missing {
                    let mut raw_secret = [0u8; 16];
                    raw_secret.copy_from_slice(Uuid::new_v4().as_bytes());
                    let encoded = BASE64_STANDARD.encode(raw_secret);
                    set_generic_password(&self.service, &self.account, encoded.as_bytes())
                        .map_err(|_| "钥匙串不可用，无法安全保存登录".to_string())?;
                    let derived = derive_macos_oscrypt_v10_key(encoded.as_bytes());
                    *self.cached_v10_key.lock().unwrap() = Some(derived);
                    Ok(derived)
                } else {
                    Err("请解锁 macOS 钥匙串后重新打开猫猫".to_string())
                }
            }
        }
    }

    fn load_gcm_key(&self) -> Result<[u8; 32], String> {
        if let Some(key) = *self.cached_gcm_key.lock().unwrap() {
            return Ok(key);
        }
        use security_framework::passwords::get_generic_password;
        let secret_bytes = get_generic_password(&self.service, &self.account)
            .map_err(|_| "请解锁 macOS 钥匙串后重新打开猫猫".to_string())?;
        let encoded = std::str::from_utf8(&secret_bytes)
            .map_err(|_| "钥匙串密钥格式无效".to_string())?
            .trim();
        let raw = BASE64_STANDARD
            .decode(encoded)
            .map_err(|_| "钥匙串密钥无法解码".to_string())?;
        let key: [u8; 32] = raw
            .try_into()
            .map_err(|_| "钥匙串密钥长度不正确".to_string())?;
        *self.cached_gcm_key.lock().unwrap() = Some(key);
        Ok(key)
    }
}

#[cfg(target_os = "macos")]
impl Cipher for KeychainCipher {
    fn is_encryption_available(&self) -> bool {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(&self.service, &self.account) {
            Ok(_) => true,
            // Item not yet created is normal on first sign-in; locked/denied keychain returns other OSStatus codes.
            Err(err) => err.code() == -25300,
        }
    }

    fn encrypt_string(&self, text: &str) -> Result<Vec<u8>, String> {
        // Write Electron-compatible OSCrypt v10 format so rollbacks to Electron `safeStorage` also work seamlessly.
        let key = self.load_or_create_oscrypt_v10_key(true)?;
        encrypt_oscrypt_v10(text, &key)
    }

    fn decrypt_string(&self, bytes: &[u8]) -> Result<String, String> {
        if bytes.starts_with(OSCRYPT_V10_PREFIX) {
            let key = self.load_or_create_oscrypt_v10_key(false)?;
            return decrypt_oscrypt_v10(bytes, &key);
        }
        if bytes.len() >= ENVELOPE_HEADER.len() + 12 + 16 && bytes.starts_with(ENVELOPE_HEADER) {
            let raw_key = self.load_gcm_key()?;
            let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&raw_key));
            let nonce_start = ENVELOPE_HEADER.len();
            let nonce = Nonce::from_slice(&bytes[nonce_start..nonce_start + 12]);
            let plaintext = cipher
                .decrypt(nonce, &bytes[nonce_start + 12..])
                .map_err(|_| "无法解密密文".to_string())?;
            return String::from_utf8(plaintext).map_err(|_| "UTF-8 无效".to_string());
        }
        Err("损坏的密文头".to_string())
    }
}

pub struct EncryptedSessionStore {
    directory: PathBuf,
    cipher: Arc<dyn Cipher>,
    queue: Mutex<()>,
}

impl EncryptedSessionStore {
    pub fn new(directory: impl Into<PathBuf>, cipher: Arc<dyn Cipher>) -> Self {
        Self {
            directory: directory.into(),
            cipher,
            queue: Mutex::new(()),
        }
    }
}

fn ensure_dir_0700(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        return Ok(());
    }
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|_| "无法创建本机应用目录".to_string())
}

fn write_atomic_0600(dir: &Path, prefix: &str, target_name: &str, bytes: &[u8]) -> Result<(), String> {
    ensure_dir_0700(dir)?;
    let temp = dir.join(format!("{prefix}-{}.tmp", Uuid::new_v4()));
    let write_res = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&temp, dir.join(target_name))?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&temp);
    write_res.map_err(|_| "无法写入本机数据文件".to_string())
}

fn dedup_valid_ids(value: Option<&Value>) -> Option<Vec<String>> {
    let arr = value?.as_array()?;
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let s = item.as_str()?;
        if s.trim().is_empty() || s.chars().count() > 254 {
            return None;
        }
        if seen.insert(s.to_string()) {
            out.push(s.to_string());
        }
    }
    Some(out)
}

#[async_trait]
impl SessionStore for EncryptedSessionStore {
    async fn load_view(&self) -> Result<Option<SavedView>, String> {
        let _guard = self.queue.lock().await;
        let path = self.directory.join("view.json");
        let text = match tokio::fs::read_to_string(&path).await {
            Ok(t) => t,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("无法读取上次选择的电脑".to_string()),
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return Ok(None);
        };
        let Some(obj) = value.as_object() else {
            return Ok(None);
        };
        let Some(owner_id) = obj.get("ownerId").and_then(Value::as_str) else {
            return Ok(None);
        };
        // Older versions stored a single `deviceId` (string or null); preserve on upgrade.
        let ids = if let Some(device_ids_val) = obj.get("deviceIds") {
            dedup_valid_ids(Some(device_ids_val))
        } else {
            match obj.get("deviceId") {
                Some(Value::String(s)) if !s.trim().is_empty() && s.chars().count() <= 254 => {
                    Some(vec![s.clone()])
                }
                Some(Value::Null) => Some(Vec::new()),
                _ => None,
            }
        };
        let order = match obj.get("deviceOrder") {
            Some(v) => dedup_valid_ids(Some(v)),
            None => Some(Vec::new()),
        };
        match (ids, order) {
            (Some(device_ids), Some(device_order)) => Ok(Some(SavedView {
                owner_id: owner_id.to_string(),
                device_ids,
                device_order,
            })),
            _ => Ok(None),
        }
    }

    async fn save_view(&self, value: SavedView) -> Result<(), String> {
        let _guard = self.queue.lock().await;
        let json = serde_json::to_vec(&value).map_err(|_| "无法序列化电脑视图".to_string())?;
        let dir = self.directory.clone();
        tokio::task::spawn_blocking(move || write_atomic_0600(&dir, "view", "view.json", &json))
            .await
            .map_err(|_| "无法保存电脑选择或顺序，请重试".to_string())?
    }

    async fn load(&self) -> Result<Option<AuthTokenPair>, String> {
        let _guard = self.queue.lock().await;
        let path = self.directory.join("session.enc");
        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("无法读取本机登录记录".to_string()),
        };
        if !self.cipher.is_encryption_available() {
            return Err("请解锁 macOS 钥匙串后重新打开猫猫".to_string());
        }
        let decrypted = self
            .cipher
            .decrypt_string(&bytes)
            .map_err(|_| "无法解密本机登录记录，原文件已保留".to_string())?;
        let parsed: AuthTokenPair = serde_json::from_str(&decrypted)
            .map_err(|_| "无法解密本机登录记录，原文件已保留".to_string())?;
        parsed
            .validate()
            .map_err(|_| "无法解密本机登录记录，原文件已保留".to_string())?;
        Ok(Some(parsed))
    }

    async fn save(&self, value: Option<AuthTokenPair>) -> Result<(), String> {
        let _guard = self.queue.lock().await;
        let dir = self.directory.clone();
        let Some(tokens) = value else {
            let _ = tokio::fs::remove_file(dir.join("view.json")).await;
            let _ = tokio::fs::remove_file(dir.join("session.enc")).await;
            return Ok(());
        };
        tokens
            .validate()
            .map_err(|_| "登录凭证格式不正确".to_string())?;
        if !self.cipher.is_encryption_available() {
            return Err("钥匙串不可用，无法安全保存登录".to_string());
        }
        let json = serde_json::to_string(&tokens).map_err(|_| "无法编码登录状态".to_string())?;
        let encrypted = self.cipher.encrypt_string(&json)?;
        tokio::task::spawn_blocking(move || write_atomic_0600(&dir, "session", "session.enc", &encrypted))
            .await
            .map_err(|_| "无法写入本机登录文件".to_string())?
    }
}

fn is_valid_quota_cat_device_id(id: &str) -> bool {
    let Some(uuid_part) = id.strip_prefix("quota-cat-") else {
        return false;
    };
    uuid_part.len() == 36
        && uuid_part
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-')
}

pub fn load_device_id(directory: &Path) -> Result<String, String> {
    ensure_dir_0700(directory)?;
    let file = directory.join("device-id");
    match std::fs::read_to_string(&file) {
        Ok(content) => {
            let id = content.trim();
            if is_valid_quota_cat_device_id(id) {
                return Ok(id.to_string());
            }
            return Err("设备标识损坏，原文件已保留".to_string());
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(_) => return Err("无法读取本机设备标识".to_string()),
    }
    let id = format!("quota-cat-{}", Uuid::new_v4());
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file)
        .map_err(|_| "无法保存本机设备标识".to_string())?;
    f.write_all(id.as_bytes())
        .map_err(|_| "无法保存本机设备标识".to_string())?;
    Ok(id)
}
