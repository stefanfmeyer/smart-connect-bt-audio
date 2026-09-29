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
 * Connect via the Tauri Rust backend over Bluetooth Classic RFCOMM.
 * All endpoint/framing probing is skipped: this transport is the one the
 * reference implementations use, with framing 'spp-style'.
 */
export async function connectTauri(log: (line: string) => void, deviceId?: string): Promise<TransportSession> {
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

  let frameBuffer: number[] = [];
  const session = await tauriConnect(target.id, {
    onData: (bytes) => {
      // Forward raw bytes to the onRx hook (set below once resolved).
      if (session2.onRx) {
        session2.onRx(bytes);
      } else {
        frameBuffer = frameBuffer.concat(Array.from(bytes));
      }
    },
    onClose: () => session2.onClose?.(),
  });

  const session2: TransportSession & { onRx: ((bytes: Uint8Array) => void) | null; onClose: (() => void) | null } = {
    framing: 'spp-style',
    deviceName: session.deviceName ?? target.name,
    write: async (bytes) => {
      await session.write(bytes);
    },
    close: () => session.close(),
    onRx: null,
    onClose: null,
  };

  void frameBuffer;
  log(`RFCOMM channel open to "${session2.deviceName}"`);
  return session2;
}
