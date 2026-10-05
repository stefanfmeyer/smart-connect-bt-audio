// Windows implementation: Bluetooth Classic RFCOMM GAIA channel.
//
// Uses WinRT (windows crate 0.61): enumerate paired devices' RFCOMM GAIA
// services (Sennheiser SDP UUID a2129ff3-081b-4c45-8afe-469d9c4842ec), open a
// StreamSocket, then pump RX through a reader thread that emits `gaia-rx`
// (byte arrays) and `gaia-closed` events to the frontend.
//
// Wire format on this transport is the GAIA SPP frame (FF 03|04 lenHi lenLo
// vendorHi vendorLo cmdHi cmdLo payload) — see lib/ble/gaia-framing.ts,
// 'spp-style'.
//
// API notes (verified against windows-0.61.1 source):
//  - RfcommServiceId::FromUuid(GUID) -> RfcommServiceId
//  - RfcommDeviceService::GetDeviceSelector() -> AQS string for ALL cached
//    RFCOMM service instances (we filter by service id client-side via
//    ServiceId().Uuid()); there is no CachedInstancesForServiceId selector.
//  - RfcommDeviceService::FromIdAsync(HSTRING) -> RfcommDeviceService (not Option)
//  - RfcommDeviceService::ConnectionHostName() / ServiceName() feed the socket

use super::GaiaDevice;
use tauri::{AppHandle, Emitter};

/// Transparent Send wrapper for WinRT stream objects.
///
/// WinRT interface wrappers are `!Send` because COM objects have thread
/// affinity in general. The StreamSocket input/output streams we use here are
/// free-threaded (agile), and each object is confined to a single owner: the
/// input stream is handed to exactly one reader thread; the DataWriter lives
/// behind a Mutex and is only touched from invoke commands. The wrapper is
/// therefore safe.
struct SendWrapper<T>(T);
unsafe impl<T> Send for SendWrapper<T> {}
impl<T> std::ops::Deref for SendWrapper<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

pub struct Connection {
    /// The socket OWNS the RFCOMM streams: it must live as long as the
    /// connection. Dropping it (as v0.1.5 accidentally did at the end of
    /// connect()) closes the underlying channel with RO_E_CLOSED
    /// (0x80000013) seconds after connect — the "channel closed during
    /// handshake" failure. Kept here (never read) purely for its lifetime.
    _socket: SendWrapper<windows::Networking::Sockets::StreamSocket>,
    /// Arc-shared writer; taken and dropped on disconnect.
    writer: std::sync::Arc<std::sync::Mutex<Option<SendWrapper<windows::Storage::Streams::DataWriter>>>>,
    /// Reader shared with the reader thread; explicitly closed on disconnect
    /// so a blocked LoadAsync returns immediately (the thread holds another
    /// Arc, so only Close() can release it).
    reader: std::sync::Mutex<Option<std::sync::Arc<SendWrapper<windows::Storage::Streams::DataReader>>>>,
    pub cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

fn gaia_guid() -> windows::core::GUID {
    // a2129ff3-081b-4c45-8afe-469d9c4842ec
    windows::core::GUID::from_u128(0xa2129ff3_081b_4c45_8afe_469d9c4842ec)
}

pub fn list_devices() -> Result<Vec<GaiaDevice>, String> {
    use windows::Devices::Bluetooth::Rfcomm::RfcommDeviceService;
    use windows::Devices::Enumeration::DeviceInformation;

    // Service-filtered AQS selector: only RFCOMM instances of the GAIA SDP id.
    let service_id = windows::Devices::Bluetooth::Rfcomm::RfcommServiceId::FromUuid(gaia_guid())
        .map_err(|e| format!("service id failed: {e}"))?;
    let selector = RfcommDeviceService::GetDeviceSelector(&service_id).map_err(|e| format!("selector failed: {e}"))?;
    let results_op = DeviceInformation::FindAllAsyncAqsFilter(&windows::core::HSTRING::from(selector))
        .map_err(|e| format!("enumeration failed: {e}"))?;
    let results = results_op.get().map_err(|e| format!("enumeration failed: {e}"))?;

    let count = results.Size().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for i in 0..count {
        let info = results.GetAt(i).map_err(|e| e.to_string())?;
        let id = info.Id().map(|n| n.to_string()).unwrap_or_default();

        // Already filtered by the selector; resolve the parent device name.
        let describe = (|| -> Result<String, String> {
            let service_op = RfcommDeviceService::FromIdAsync(&windows::core::HSTRING::from(&id)).map_err(|e| e.to_string())?;
            let service = service_op.get().map_err(|e| e.to_string())?;
            Ok(service
                .Device()
                .and_then(|d| d.Name())
                .map(|n| n.to_string())
                .unwrap_or_default())
        })();
        match describe {
            Ok(name) => out.push(GaiaDevice { id, name }),
            Err(_) => continue, // inaccessible instance (consent revoked etc.)
        }
    }
    Ok(out)
}

pub fn connect(app: &AppHandle, device_id: &str, fallback_name: &str) -> Result<(String, Connection), String> {
    use windows::Devices::Bluetooth::Rfcomm::RfcommDeviceService;
    use windows::Storage::Streams::{DataReader, DataWriter, InputStreamOptions};
    use windows::Networking::Sockets::StreamSocket;

    let service_op = RfcommDeviceService::FromIdAsync(&windows::core::HSTRING::from(device_id))
        .map_err(|e| format!("service resolve failed: {e}"))?;
    let service = service_op.get().map_err(|e| format!("service resolve failed: {e}"))?;

    let device_name = service
        .Device()
        .and_then(|d| d.Name())
        .map(|n| n.to_string())
        .unwrap_or_else(|_| fallback_name.to_string());

    let host_name = service.ConnectionHostName().map_err(|e| format!("host name failed: {e}"))?;
    let service_name = service
        .ConnectionServiceName()
        .map_err(|e| format!("service name failed: {e}"))?;

    // Candidate RFCOMM channels: the SDP-cached service name first, then the
    // channel set proven on the MOMENTUM 4 (f3Y0/momentum4-control probes
    // [2, 1, 15, 14, 12, ...] because the SDP/default channel can open and
    // still never speak GAIA). Each channel must answer a GAIA query before
    // it is accepted; mute channels are skipped automatically.
    let mut channels: Vec<String> = vec![service_name.to_string()];
    for ch in [2u8, 1, 15, 14, 12, 3, 4, 5, 6, 7, 8, 9, 10, 11] {
        let c = ch.to_string();
        if !channels.contains(&c) {
            channels.push(c);
        }
    }

    // Cached winning channel first: reconnects answer in a single probe and
    // the dead-channel scan never runs again (until the cache entry misses,
    // in which case the full scan below still finds the channel and re-saves).
    if let Some(hit) = cached_channel(app, device_id) {
        if let Some(pos) = channels.iter().position(|c| *c == hit) {
            channels.remove(pos);
        }
        channels.insert(0, hit);
    }

    let mut last_err = String::new();
    for channel in &channels {
        let socket = StreamSocket::new().map_err(|e| e.to_string())?;
        let connect_op = socket
            .ConnectAsync(&host_name, &windows::core::HSTRING::from(channel))
            .map_err(|e| format!("socket connect failed: {e}"))?;
        // Bounded wait: a dead channel must not hang the connect (explicit
        // Cancel + drop of the socket cancels the outstanding operation).
        if !wait_for_status(|| connect_op.Status().map(|s| s.0), 2500) {
            let _ = connect_op.Cancel();
            last_err = format!("channel {channel}: connect did not complete in 2.5s");
            continue;
        }
        if let Err(e) = connect_op.get() {
            last_err = format!("channel {channel}: connect failed: {e}");
            continue;
        }

        // GAIA probe: ANC get (0x1A05) — the query proven to be answered by
        // the MOMENTUM 4 (battery is ignored by that model). Any valid GAIA
        // reply is accepted; we only check that bytes come back.
        //
        // The probe runs through the SAME writer/reader the session keeps.
        // v0.1.5 used throwaway probe objects AND never kept the socket: the
        // WinRT teardown closed the underlying stream seconds after connect()
        // returned, surfacing as RO_E_CLOSED (0x80000013) during the frontend
        // handshake. No throwaway objects exist anymore: on success everything
        // moves into the Connection, on failure the candidate channel is dead
        // anyway and dropping the locals closes it — exactly what we want.
        let out = socket.OutputStream().map_err(|e| e.to_string())?;
        let writer = DataWriter::CreateDataWriter(&out).map_err(|e| e.to_string())?;
        writer
            .WriteBytes(&probe_frame())
            .map_err(|e| format!("write failed: {e}"))?;
        writer
            .StoreAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| format!("store failed: {e}"))?;

        let input = socket.InputStream().map_err(|e| e.to_string())?;
        let session_reader = DataReader::CreateDataReader(&input).map_err(|e| e.to_string())?;
        let _ = session_reader.SetInputStreamOptions(InputStreamOptions::Partial);

        let probe_answered = {
            let load_op = session_reader.LoadAsync(64).map_err(|e| e.to_string())?;
            // 3s: slow links must not get their (correct) channel skipped.
            if wait_for_status(|| load_op.Status().map(|s| s.0), 3000) {
                match load_op.get() {
                    Ok(n) if n > 0 => {
                        // Consume the probe answer. Left unread it stays at the
                        // head of the DataReader's unconsumed buffer and SHIFTS
                        // the whole stream by one frame: every response is then
                        // delivered one command late, each exchange burns its
                        // full timeout, and connecting takes minutes (observed
                        // live on v0.1.7). Reading the bytes here unshifts it.
                        let mut probe_buf = vec![0u8; n as usize];
                        session_reader.ReadBytes(&mut probe_buf).is_ok()
                    }
                    _ => false,
                }
            } else {
                let _ = load_op.Cancel();
                false
            }
        };
        if !probe_answered {
            last_err = format!("channel {channel}: GAIA probe got no answer");
            continue;
        }

        let writer = std::sync::Arc::new(std::sync::Mutex::new(Some(SendWrapper(writer))));
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = std::sync::Arc::new(SendWrapper(session_reader));

        // Reader thread: blocking reads are fine off the UI thread. The
        // DataReader is shared (Arc) so disconnect can Close() it to release
        // a blocked read; the socket itself moves into the returned
        // Connection so the channel stays open for the session's lifetime.
        {
            let app = app.clone();
            let cancel = cancel.clone();
            let thread_reader = reader.clone();
            std::thread::spawn(move || reader_loop(app, cancel, thread_reader));
        }

        // Display name: the device name only. The RFCOMM service-instance
        // string Windows returns as "channel" is plumbing (a long
        // Bluetooth#...#RFCOMM:...{uuid} blob) and stays in the console log,
        // not in the header.
        let display = if device_name.is_empty() {
            "headphones".to_string()
        } else {
            device_name
        };
        remember_channel(app, device_id, channel);
        return Ok((
            display,
            Connection {
                _socket: SendWrapper(socket),
                writer,
                reader: std::sync::Mutex::new(Some(reader)),
                cancel,
            },
        ));
    }

    Err(format!(
        "RFCOMM connect failed: no candidate channel answered a GAIA command. Last attempt: {last_err}. \
         If this persists, close the official Smart Control app (it may be holding the control link), \
         toggle the headphones off/on, and retry."
    ))
}

/// Probe frame: GAIA ANC get 0x1A05 (vendor 0x0495), SPP framing, no payload.
fn probe_frame() -> [u8; 8] {
    [0xff, 0x03, 0x00, 0x00, 0x04, 0x95, 0x1a, 0x05]
}

/// Poll an async operation's status until Completed (true) or deadline (false).
/// Never blocks indefinitely: the caller drops the owning object to cancel.
/// Status codes (Windows.Foundation.AsyncStatus): 0 Started, 1 Completed,
/// 2 Canceled, 3 Error — compared raw so we need no windows-future dep.
fn wait_for_status<F>(mut status: F, timeout_ms: u64) -> bool
where
    F: FnMut() -> windows::core::Result<i32>,
{
    let start = std::time::Instant::now();
    loop {
        if let Ok(code) = status() {
            if code == 1 {
                return true; // Completed
            }
            if code != 0 {
                return false; // Canceled or Error
            }
        }
        if start.elapsed().as_millis() as u64 >= timeout_ms {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
}

fn reader_loop(
    app: AppHandle,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    reader: std::sync::Arc<SendWrapper<windows::Storage::Streams::DataReader>>,
) {
    let cancelled = || cancel.load(std::sync::atomic::Ordering::Relaxed);
    let mut buf = [0u8; 1024];
    loop {
        // Deliberate disconnect: cancel set -> exit silently.
        if cancelled() {
            return;
        }
        let n = match reader
            .LoadAsync(buf.len() as u32)
            .map_err(|e| e.to_string())
            .and_then(|op| op.get().map_err(|e| e.to_string()))
        {
            Ok(n) => n as usize,
            Err(e) => {
                if !cancelled() {
                    let _ = app.emit("gaia-closed", format!("read failed: {e}"));
                }
                return;
            }
        };
        if n == 0 {
            if !cancelled() {
                let _ = app.emit(
                    "gaia-closed",
                    "stream ended (device closed the channel)".to_string(),
                );
            }
            return;
        }
        if let Err(e) = reader.ReadBytes(&mut buf[..n]) {
            if !cancelled() {
                let _ = app.emit("gaia-closed", format!("read failed: {e}"));
            }
            return;
        }
        let _ = app.emit("gaia-rx", buf[..n].to_vec());
    }
}

pub fn write(conn: &Connection, bytes: &[u8]) -> Result<(), String> {
    let guard = conn.writer.lock().unwrap();
    if let Some(writer) = guard.as_ref() {
        writer
            .WriteBytes(bytes)
            .map_err(|e| format!("write failed: {e}"))?;
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
    conn.cancel
        .store(true, std::sync::atomic::Ordering::Relaxed);
    // Release the reader thread first: a blocked LoadAsync returns as soon
    // as the DataReader is closed. Its error paths check `cancel` and stay
    // silent, so no spurious gaia-closed reaches the frontend.
    if let Some(reader) = conn.reader.lock().unwrap().take() {
        let _ = reader.Close();
    }
    // Dropping the DataWriter and the socket (fields of Connection) closes
    // the stream and the RFCOMM channel: teardown is now explicit and owned.
}
