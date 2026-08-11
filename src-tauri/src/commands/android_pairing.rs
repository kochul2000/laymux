use std::sync::Arc;

use tauri::State;

use crate::android_pairing::{AndroidPairingQr, AndroidPairingStatus};
use crate::state::AppState;

#[tauri::command]
pub async fn get_android_pairing_status() -> Result<AndroidPairingStatus, String> {
    crate::android_pairing::get_status()
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn create_android_pairing_qr(
    state: State<'_, Arc<AppState>>,
) -> Result<AndroidPairingQr, String> {
    crate::android_pairing::create(state.inner().clone())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn revoke_android_pairing() -> Result<AndroidPairingStatus, String> {
    crate::android_pairing::revoke().await.map_err(Into::into)
}
