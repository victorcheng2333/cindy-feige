use serde::Deserialize;
use std::sync::OnceLock;

static ENDPOINT_JSON: &str = include_str!("../../../../config/endpoint.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoints {
    pub auth_api_base_url: String,
    pub device_link_api_base_url: String,
    pub auth_desktop_callback_url: String,
}

pub fn endpoints() -> &'static Endpoints {
    static PARSED: OnceLock<Endpoints> = OnceLock::new();
    PARSED.get_or_init(|| {
        serde_json::from_str(ENDPOINT_JSON).expect("valid config/endpoint.json")
    })
}

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
