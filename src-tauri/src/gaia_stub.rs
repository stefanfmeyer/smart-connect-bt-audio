// Non-Windows stub: keeps the crate compiling on Linux/macOS dev machines.
// The real transport is Windows-only (WinRT RFCOMM); see gaia_win.rs.

use super::GaiaDevice;
use tauri::AppHandle;

pub struct Connection;

pub fn list_devices() -> Result<Vec<GaiaDevice>, String> {
    Err("Bluetooth Classic RFCOMM is only implemented on Windows in this build.".into())
}

pub fn connect(_app: &AppHandle, _device_id: &str, _name: &str) -> Result<(String, Connection), String> {
    Err("Bluetooth Classic RFCOMM is only implemented on Windows in this build.".into())
}

pub fn write(_conn: &Connection, _bytes: &[u8]) -> Result<(), String> {
    Err("not supported on this platform".into())
}

pub fn disconnect(_conn: Connection) {}
