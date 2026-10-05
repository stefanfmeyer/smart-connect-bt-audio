// Linux implementation: Bluetooth Classic RFCOMM GAIA channel via BlueZ.
//
// Uses bluer (the official BlueZ Rust bindings, DBus/bluetoothd). Pairing is
// expected to have happened already (GNOME/KDE Bluetooth settings, bluetoothctl);
// the app enumerates paired devices exposing the Sennheiser GAIA SDP UUID
// a2129ff3-081b-4c45-8afe-469d9c4842ec, then opens an RFCOMM stream the same
// way the Windows backend does: probe the candidate channels, accept only the
// one that ANSWERS a GAIA query, remember the winner on disk.
//
// Wire format and events are identical to the Windows backend:
// GAIA SPP frame (FF 03|04 lenHi lenLo vendorHi vendorLo cmdHi cmdLo payload),
// `gaia-rx` (byte arrays) and `gaia-closed` (reason) events to the frontend.

use super::{cached_channel, remember_channel, GaiaDevice};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

const GAIA_UUID_U128: u128 = 0xa2129ff3_081b_4c45_8afe_469d9c4842ec;

/// Candidate RFCOMM channels, identical to the Windows backend: the proven
/// MOMENTUM 4 set first (f3Y0/momentum4-control probes [2, 1, 15, 14, 12, ...]
/// because the SDP/default channel can open and still never speak GAIA).
const CHANNELS: [u8; 14] = [2, 1, 15, 14, 12, 3, 4, 5, 6, 7, 8, 9, 10, 11];

pub struct Connection {
    /// Owning write half: dropping it shuts down the write direction, the
    /// reader thread then sees EOF/error and exits (silently: cancel flag).
    /// Behind a Mutex so `write()` can take it by &self (async writes run on
    /// the shared runtime; invoke commands are the only users).
    write_half: std::sync::Mutex<Option<bluer::rfcomm::stream::OwnedWriteHalf>>,
    pub cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// Shared multi-thread tokio runtime for all blocking entry points.
fn rt() -> &'static tokio::runtime::Runtime {
    static RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
    })
}

async fn gaia_session() -> Result<(bluer::Adapter, Vec<(bluer::Address, String)>), String> {
    let session = bluer::Session::new().await.map_err(|e| {
        format!(
            "Bluetooth daemon (bluetoothd) unavailable: {e}. Is the bluez package installed and running (systemctl status bluetooth)?"
        )
    })?;
    let adapter = session.default_adapter().await.map_err(|e| {
        format!("no default Bluetooth adapter: {e}. Is a Bluetooth adapter present and powered?")
    })?;
    adapter
        .set_powered(true)
        .await
        .map_err(|e| format!("failed to power the Bluetooth adapter: {e}"))?;

    let mut out = Vec::new();
    let addresses = adapter
        .device_addresses()
        .await
        .map_err(|e| format!("failed to enumerate paired devices: {e}"))?;
    for addr in addresses {
        let device = match adapter.device(addr) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let paired = device.is_paired().await.unwrap_or(false);
        if !paired {
            continue;
        }
        // Only devices that advertise the GAIA service UUID. If the device
        // does not expose its UUID list at all, keep it (the GAIA probe at
        // connect time is the real gate).
        let uuids = device.uuids().await.unwrap_or_default();
        let is_gaia = match uuids {
            Some(set) => set.is_empty() || set.iter().any(|u| u.as_u128() == GAIA_UUID_U128),
            None => true,
        };
        if !is_gaia {
            continue;
        }
        let name = device.alias().await.unwrap_or_default();
        out.push((addr, name));
    }
    Ok((adapter, out))
}

pub fn list_devices() -> Result<Vec<GaiaDevice>, String> {
    let (_, devices) = rt().block_on(gaia_session())?;
    Ok(devices
        .into_iter()
        .map(|(addr, name)| GaiaDevice {
            id: addr.to_string(),
            name,
        })
        .collect())
}

pub fn connect(_app: &AppHandle, device_id: &str, fallback_name: &str) -> Result<(String, Connection), String> {
    let addr: bluer::Address = device_id
        .parse()
        .map_err(|_| format!("invalid Bluetooth address: {device_id}"))?;

    let (name, stream, channel) = rt().block_on(async {
        // Resolve the display name (best effort).
        let session = bluer::Session::new().await.map_err(|e| format!("bluetoothd unavailable: {e}"))?;
        let adapter = session
            .default_adapter()
            .await
            .map_err(|e| format!("no default Bluetooth adapter: {e}"))?;
        let device = adapter.device(addr);
        let name = match device {
            Ok(d) => d.alias().await.unwrap_or_else(|_| fallback_name.to_string()),
            Err(_) => fallback_name.to_string(),
        };
        let name = if name.is_empty() { "headphones".to_string() } else { name };

        // Candidate channels: cached winner first (disk cache shared with the
        // Windows backend format), then the proven probe order.
        let mut channels: Vec<u8> = CHANNELS.to_vec();
        if let Some(hit) = cached_channel(_app, device_id) {
            if let Ok(hit_ch) = hit.parse::<u8>() {
                if let Some(pos) = channels.iter().position(|c| *c == hit_ch) {
                    channels.remove(pos);
                }
                channels.insert(0, hit_ch);
            }
        }

        let probe = probe_frame();
        let mut last_err = String::new();
        for channel in channels {
            let sa = bluer::rfcomm::SocketAddr::new(addr, channel);
            // Bounded connect: a dead channel must not hang the connect.
            let connect = bluer::rfcomm::Stream::connect(sa);
            let mut stream = match tokio::time::timeout(std::time::Duration::from_millis(2500), connect).await {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => {
                    last_err = format!("channel {channel}: connect failed: {e}");
                    continue;
                }
                Err(_) => {
                    last_err = format!("channel {channel}: connect did not complete in 2.5s");
                    continue;
                }
            };

            // GAIA probe: ANC get (0x1A05), same as Windows. The channel only
            // counts when the device ANSWERS. The probe answer is consumed
            // here so the session stream is never shifted (v0.1.8 lesson).
            if let Err(e) = stream.write_all(&probe).await {
                last_err = format!("channel {channel}: probe write failed: {e}");
                continue;
            }
            let mut buf = [0u8; 64];
            let read = tokio::time::timeout(std::time::Duration::from_secs(3), stream.read(&mut buf)).await;
            match read {
                Ok(Ok(n)) if n > 0 => {
                    // Consume probe answer above; stream is unshifted.
                    return Ok((name, stream, channel));
                }
                Ok(Ok(_)) => {
                    last_err = format!("channel {channel}: GAIA probe got EOF");
                    continue;
                }
                Ok(Err(e)) => {
                    last_err = format!("channel {channel}: GAIA probe read failed: {e}");
                    continue;
                }
                Err(_) => {
                    last_err = format!("channel {channel}: GAIA probe got no answer");
                    continue;
                }
            }
        }
        Err(format!(
            "RFCOMM connect failed: no candidate channel answered a GAIA command. Last attempt: {last_err}. \
             Make sure the headphones are paired and powered on, and that no other app holds the control link."
        ))
    })?;

    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (mut read_half, write_half) = stream.into_split();
    remember_channel(_app, device_id, &channel.to_string());

    // Reader task: emits gaia-rx / gaia-closed, exits silently on cancel.
    {
        let app = _app.clone();
        let cancel = cancel.clone();
        rt().spawn(async move {
            let mut buf = [0u8; 1024];
            loop {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                match read_half.read(&mut buf).await {
                    Ok(0) => {
                        if !cancel.load(std::sync::atomic::Ordering::Relaxed) {
                            let _ = app.emit("gaia-closed", "stream ended (device closed the channel)".to_string());
                        }
                        return;
                    }
                    Ok(n) => {
                        let _ = app.emit("gaia-rx", buf[..n].to_vec());
                    }
                    Err(e) => {
                        if !cancel.load(std::sync::atomic::Ordering::Relaxed) {
                            let _ = app.emit("gaia-closed", format!("read failed: {e}"));
                        }
                        return;
                    }
                }
            }
        });
    }

    Ok((
        name,
        Connection {
            write_half: std::sync::Mutex::new(Some(write_half)),
            cancel,
        },
    ))
}

/// Probe frame: GAIA ANC get 0x1A05 (vendor 0x0495), SPP framing, no payload.
fn probe_frame() -> [u8; 8] {
    [0xff, 0x03, 0x00, 0x00, 0x04, 0x95, 0x1a, 0x05]
}

pub fn write(conn: &Connection, bytes: &[u8]) -> Result<(), String> {
    // Take the write half out, async-write it (borrowed — block_on has no
    // 'static bound), put it back. Invoke commands are serialized by Tauri;
    // the Mutex is only contended in theory.
    let mut guard = conn.write_half.lock().unwrap();
    let mut half = guard.take().ok_or("socket closed")?;
    let result = rt().block_on(async {
        match half.write_all(bytes).await {
            Ok(()) => Ok(()),
            Err(e) => Err(format!("write failed: {e}")),
        }
    });
    // On error the half is NOT returned: the connection is dead anyway and
    // dropping it closes the socket (the reader task reports gaia-closed).
    if result.is_ok() {
        *guard = Some(half);
    }
    result
}

pub fn disconnect(conn: Connection) {
    conn.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    // Dropping the write half closes the socket: the reader task sees EOF and
    // exits silently (it checks the cancel flag first).
    drop(conn);
}
