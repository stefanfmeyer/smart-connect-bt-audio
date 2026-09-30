/**
 * Transport abstraction: Web Bluetooth (browser) or Tauri RFCOMM (desktop).
 *
 * The GAIA protocol layer is transport-independent: a transport moves raw
 * frames. Web Bluetooth probes framings because the BLE wire format is
 * undocumented; Tauri/RFCOMM is always 'spp-style' (verified against the
 * reference captures).
 */

import { GaiaClient } from './gaia-client';
import { Framing } from './gaia-framing';
import { GaiaDevice, isTauri, listGaiaDevices, tauriConnect } from './tauri-bridge';

export interface TransportDevice {
  id: string;
  name: string;
}

export interface TransportSession {
  write: (bytes: Uint8Array) => Promise<void>;
  close: () => void;
  framing: Framing;
  deviceName: string;
}

export type TransportKind = 'web-bluetooth' | 'tauri-rfcomm';

export async function availableTransport(): Promise<TransportKind | null> {
  if (isTauri()) return 'tauri-rfcomm';
  if (typeof navigator !== 'undefined' && navigator.bluetooth) return 'web-bluetooth';
  return null;
}

/**
 * Connect via the browser path (unchanged behaviour: device picker +
 * endpoint probing inside GaiaClient).
 */
export async function connectWebBluetooth(log: (line: string) => void, showAllDevices: boolean): Promise<{ client: GaiaClient; session: TransportSession }> {
  const client = new GaiaClient(log);
  const name = await client.connect({ showAllDevices });
  return {
    client,
    session: {
      framing: client.activeFraming,
      deviceName: name,
      write: async (bytes) => client.writeRaw(bytes),
      close: () => client.disconnect(),
    },
  };
}

/**
 * Connect via the Tauri Rust backend over Bluetooth Classic RFCOMM and return
 * a GaiaClient with the transport attached: the caller uses the client exactly
 * like the Web Bluetooth one (exchange(), notifications, protocol log). All
 * endpoint/framing probing is skipped: this transport is the one the reference
 * implementations use, with framing 'spp-style'.
 */
export async function connectTauri(log: (line: string) => void, deviceId?: string): Promise<{ client: GaiaClient; session: TransportSession }> {
  const devices = await listGaiaDevices();
  log(`desktop backend: ${devices.length} paired GAIA device(s) found`);
  if (devices.length === 0) {
    throw new Error(
      'No paired GAIA (RFCOMM) devices found. Pair the headphones in Windows Bluetooth settings first, then retry. ' +
        'If they are listed there but not here, Windows may not have cached the GAIA service yet — toggle the headphones off/on.',
    );
  }
  const target = (deviceId && devices.find((d) => d.id === deviceId)) || devices[0];
  log(`connecting RFCOMM GAIA channel to "${target.name}"...`);

  const client = new GaiaClient(log);

  // RX can race ahead of the socket handshake resolving; buffer until the
  // client is attached, then drain in order.
  let early: Uint8Array[] = [];
  let closedEarly = false;
  let rxSink: ((bytes: Uint8Array) => void) | null = null;
  let closeSink: (() => void) | null = null;

  const session = await tauriConnect(target.id, {
    onData: (bytes) => {
      if (rxSink) rxSink(bytes);
      else early.push(bytes);
    },
    onClose: () => {
      if (closeSink) closeSink();
      else closedEarly = true;
    },
  });

  const transport: TransportSession = {
    framing: 'spp-style',
    deviceName: session.deviceName || target.name,
    write: (bytes) => session.write(bytes),
    close: () => session.close(),
  };
  client.attachTransport(transport);

  rxSink = (bytes) => client.ingestTransportBytes(bytes);
  closeSink = () => client.handleTransportClosed();

  const buffered = early;
  early = [];
  for (const bytes of buffered) client.ingestTransportBytes(bytes);
  if (closedEarly) closeSink();

  log(`RFCOMM channel open to "${transport.deviceName}"`);
  return { client, session: transport };
}
