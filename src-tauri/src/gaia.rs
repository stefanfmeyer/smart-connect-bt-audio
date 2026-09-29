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

#[cfg(not(windows))]
mod platform {
    include!("gaia_stub.rs");
}

pub struct GaiaState(pub Mutex<Option<platform::Connection>>);

pub fn new_state() -> GaiaState {
    GaiaState(Mutex::new(None))
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
