// Windows implementation: Bluetooth Classic RFCOMM GAIA channel.
//
// Uses WinRT (windows crate): resolve the paired device's RFCOMM service for
// the Sennheiser GAIA SDP UUID (a2129ff3-081b-4c45-8afe-469d9c4842ec), open a
// StreamSocket, then pump RX through a reader thread that emits `gaia-rx`
// (byte arrays) and `gaia-closed` events to the frontend.
//
// Wire format on this transport is the GAIA SPP frame (FF 03|04 lenHi lenLo
// vendorHi vendorLo cmdHi cmdLo payload) — see lib/ble/gaia-framing.ts,
// 'spp-style'.

use super::GaiaDevice;
use tauri::{AppHandle, Emitter};

pub const GAIA_SDP_UUID: &str = "a2129ff3-081b-4c45-8afe-469d9c4842ec";

pub struct Connection {
    /// Arc-shared writer; taken and dropped on disconnect.
    pub writer: std::sync::Arc<std::sync::Mutex<Option<windows::Storage::Streams::DataWriter>>>,
    pub cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

pub fn list_devices() -> Result<Vec<GaiaDevice>, String> {
    use windows::Devices::Bluetooth::Rfcomm::{RfcommDeviceService, RfcommServiceId};
    use windows::Devices::Enumeration::DeviceInformation;

    let service_id = RfcommServiceId::FromUuid(windows::core::GUID::from(GAIA_SDP_UUID))
        .map_err(|e| format!("RfcommServiceId::FromUuid failed: {e}"))?;

    // Cached instances: services of already-paired devices. No scan needed —
    // the headphones are paired with Windows at the OS level.
    let selector = RfcommDeviceService::GetDeviceSelectorForCachedInstancesForServiceId(&service_id)
        .map_err(|e| format!("selector failed: {e}"))?;
    let results_op = DeviceInformation::FindAllAsyncAqsFilter(&selector)
        .map_err(|e| format!("enumeration failed: {e}"))?;
    let results = results_op.get().map_err(|e| format!("enumeration failed: {e}"))?;

    let count = results.Size().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for i in 0..count {
        let info = results.GetAt(i).map_err(|e| e.to_string())?;
        let name = info.Name().map(|n| n.to_string()).unwrap_or_default();
        let id = info.Id().map(|n| n.to_string()).unwrap_or_default();
        out.push(GaiaDevice { id, name });
    }
    Ok(out)
}

pub fn connect(app: &AppHandle, device_id: &str, fallback_name: &str) -> Result<(String, Connection), String> {
    use windows::Devices::Bluetooth::Rfcomm::RfcommDeviceService;
    use windows::Networking::Sockets::StreamSocket;
    use windows::Storage::Streams::DataWriter;

    let service_op = RfcommDeviceService::FromIdAsync(&windows::core::HSTRING::from(device_id))
        .map_err(|e| format!("service resolve failed: {e}"))?;
    let service = match service_op.get().map_err(|e| e.to_string())? {
        Some(s) => s,
        None => {
            return Err(
                "RFCOMM service not found — are the headphones paired in Windows Bluetooth settings, \
                 and has this app been granted access to them?"
                    .into(),
            )
        }
    };

    // RfcommDeviceService.Device() is already a BluetoothDevice.
    let bt_device = service.Device().map_err(|e| format!("device handle failed: {e}"))?;
    let device_name = bt_device
        .Name()
        .map(|n| n.to_string())
        .unwrap_or_else(|_| fallback_name.to_string());

    let host_name = bt_device
        .ConnectionHostName()
        .map_err(|e| format!("host name failed: {e}"))?;
    let service_name = service.ServiceName().map_err(|e| format!("service name failed: {e}"))?;

    let socket = StreamSocket::new().map_err(|e| e.to_string())?;
    socket
        .ConnectAsync(&host_name, &service_name)
        .map_err(|e| format!("socket connect failed: {e}"))?
        .get()
        .map_err(|e| format!("RFCOMM connect failed (is the official Smart Control app holding the link?): {e}"))?;

    let out = socket.OutputStream().map_err(|e| e.to_string())?;
    let writer = DataWriter::CreateDataWriter(&out).map_err(|e| e.to_string())?;
    let writer = std::sync::Arc::new(std::sync::Mutex::new(Some(writer)));
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Reader thread: blocking reads are fine off the UI thread.
    {
        let input = socket.InputStream().map_err(|e| e.to_string())?;
        let app = app.clone();
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            use windows::Storage::Streams::{DataReader, InputStreamOptions};
            let reader = match DataReader::CreateDataReader(&input) {
                Ok(r) => r,
                Err(_) => return,
            };
            let _ = reader.InputStreamOptions(InputStreamOptions::Partial);
            let mut buf = [0u8; 1024];
            loop {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                let n = match reader.LoadAsync(buf.len() as u32).get() {
                    Ok(n) => n as usize,
                    Err(_) => break,
                };
                if n == 0 {
                    break;
                }
                if reader.ReadBytes(&mut buf[..n]).is_err() {
                    break;
                }
                let _ = app.emit("gaia-rx", buf[..n].to_vec());
            }
            let _ = app.emit("gaia-closed", ());
        });
    }

    Ok((device_name, Connection { writer, cancel }))
}

pub fn write(conn: &Connection, bytes: &[u8]) -> Result<(), String> {
    let guard = conn.writer.lock().unwrap();
    if let Some(writer) = guard.as_ref() {
        writer.WriteBytes(bytes).map_err(|e| format!("write failed: {e}"))?;
        writer
            .StoreAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| format!("store failed: {e}"))?;
        Ok(())
    } else {
        Err("socket closed".into())
    }
}

pub fn disconnect(conn: Connection) {
    conn.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Some(writer) = conn.writer.lock().unwrap().take() {
        let _ = writer.FlushAsync();
    }
}
