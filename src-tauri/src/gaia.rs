//! GAIA over Bluetooth Classic RFCOMM — command surface.
//!
//! Platform work lives in `win` (Windows WinRT) / `stub` (everything else).
//! Wire format on this transport is the GAIA SPP frame (FF 03|04 lenHi lenLo
//! vendorHi vendorLo cmdHi cmdLo payload...) — see lib/ble/gaia-framing.ts,
//! 'spp-style'.

use serde::Serialize;
use std::sync::Mutex;

#[derive(Serialize, Clone)]
pub struct GaiaDevice {
    pub id: String,
    pub name: String,
}

#[cfg(windows)]
mod platform {
    include!("gaia_win.rs");
}

#[cfg(target_os = "linux")]
mod platform {
    include!("gaia_linux.rs");
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    include!("gaia_stub.rs");
}

pub struct GaiaState(pub Mutex<Option<platform::Connection>>);

pub fn new_state() -> GaiaState {
    GaiaState(Mutex::new(None))
}

/// Channel cache: device id -> RFCOMM channel that answered the GAIA probe.
/// The winning channel is remembered on disk (app data dir) so every connect
/// after the first skips the dead-channel scan entirely. Format is shared by
/// the Windows and Linux backends (same file name, same map shape).
pub(crate) fn cache_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("data dir failed: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("rfcomm-channel-cache.json"))
}

pub(crate) fn cached_channel(app: &tauri::AppHandle, device_id: &str) -> Option<String> {
    let path = cache_path(app).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    let map: std::collections::HashMap<String, String> = serde_json::from_str(&text).ok()?;
    map.get(device_id).cloned()
}

pub(crate) fn remember_channel(app: &tauri::AppHandle, device_id: &str, channel: &str) {
    let Ok(path) = cache_path(app) else { return };
    let mut map: std::collections::HashMap<String, String> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if map.get(device_id).map(|c| c.as_str()) == Some(channel) {
        return; // already correct; skip the write
    }
    map.insert(device_id.to_string(), channel.to_string());
    if let Ok(json) = serde_json::to_string(&map) {
        let _ = std::fs::write(path, json);
    }
}

#[tauri::command]
pub fn list_devices() -> Result<Vec<GaiaDevice>, String> {
    platform::list_devices()
}

#[tauri::command]
pub fn gaia_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, GaiaState>,
    device_id: String,
    name: String,
) -> Result<String, String> {
    let (name, conn) = platform::connect(&app, &device_id, &name)?;
    *state.0.lock().unwrap() = Some(conn);
    Ok(name)
}

#[tauri::command]
pub fn gaia_write(state: tauri::State<'_, GaiaState>, bytes: Vec<u8>) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    match guard.as_ref() {
        Some(conn) => platform::write(conn, &bytes),
        None => Err("not connected".into()),
    }
}

#[tauri::command]
pub fn gaia_disconnect(state: tauri::State<'_, GaiaState>) -> Result<(), String> {
    if let Some(conn) = state.0.lock().unwrap().take() {
        platform::disconnect(conn);
    }
    Ok(())
}
