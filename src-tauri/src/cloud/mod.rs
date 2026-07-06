pub mod commands;
pub mod keyring_store;
pub mod pairing;
pub mod tunnel;

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub connected: bool,
    pub instance_id: Option<String>,
    pub last_error: Option<String>,
}
