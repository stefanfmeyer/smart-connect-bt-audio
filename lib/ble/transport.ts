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
import { CMD } from './sennheiser';
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
 * Desktop connect over Bluetooth Classic RFCOMM.
 *
 * Robustness rules learned the hard way:
 *  - The close listener is attached BEFORE the socket handshake completes,
 *    so an immediate device-side close can never be missed.
 *  - Every paired GAIA device is tried in order; Windows often keeps stale
 *    RFCOMM cache entries whose socket "connects" but carries no data.
 *  - A device only counts as connected once it ANSWERS a known GAIA query
 *    on spp-style framing (fallback: gatt-v3). "Socket open" is not enough.
 *    The gate accepts ANC/transparency/bass/battery answers — see connectOne.
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

  const candidates = deviceId ? devices.filter((d) => d.id === deviceId) : devices;
  const errors: string[] = [];

  for (const target of candidates) {
    log(`connecting RFCOMM GAIA channel to "${target.name}"...`);
    try {
      const result = await connectOne(target, log);
      log(`RFCOMM channel open to "${result.session.deviceName}" — GAIA probe answered`);
      return result;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      errors.push(`${target.name || target.id}: ${msg}`);
      log(`!! "${target.name || target.id}" failed: ${msg}`);
    }
  }

  throw new Error(
    `None of the ${candidates.length} paired GAIA device(s) answered a GAIA command. ` +
      `Tried: ${errors.join(' | ')}. ` +
      'Fixes: close the official Sennheiser app (it monopolises the control socket), take the headphones out of the case, ' +
      'toggle them off/on so Windows refreshes the RFCOMM cache, then retry.',
  );
}

/** Try a single device: open socket, wire close early, GAIA-probe, then hand over. */
async function connectOne(target: GaiaDevice, log: (line: string) => void): Promise<{ client: GaiaClient; session: TransportSession }> {
  const client = new GaiaClient(log);

  // RX/close can race ahead of the handshake resolving; buffer until wired.
  let early: Uint8Array[] = [];
  let earlyClose: string | null = null;
  let rxSink: ((bytes: Uint8Array) => void) | null = null;
  let closeSink: ((reason: string | null) => void) | null = null;

  const session = await tauriConnect(target.id, {
    onData: (bytes) => {
      if (rxSink) rxSink(bytes);
      else early.push(bytes);
    },
    onClose: (reason) => {
      if (closeSink) closeSink(reason);
      else earlyClose = reason ?? 'channel closed';
    },
  });

  const transport: TransportSession = {
    framing: 'spp-style',
    deviceName: session.deviceName || target.name,
    write: (bytes) => session.write(bytes),
    close: () => session.close(),
  };
  client.attachTransport(transport);

  let closed: string | null = null;
  rxSink = (bytes) => client.ingestTransportBytes(bytes);
  closeSink = (reason) => {
    if (closed === null) closed = reason ?? 'channel closed';
    client.handleTransportClosed();
  };

  for (const bytes of early) client.ingestTransportBytes(bytes);
  early = [];
  if (earlyClose !== null) {
    closeSink(earlyClose);
    throw new Error(`channel closed during handshake (${earlyClose})`);
  }

  // GAIA probe: the device must ANSWER before we claim "connected".
  // The gate accepts ANY known-good Sennheiser query — probing battery only
  // deadlocked the MOMENTUM 4, which silently ignores that command (f3Y0's
  // proven M4 client validates its channel with the ANC get instead).
  const gateCommands = [CMD.getAncEnabled, CMD.getTransparencyLevel, CMD.getBassBoost, CMD.getBattery];
  try {
    const answered = await client.tryCommands(gateCommands);
    if (answered === null) throw new Error('device answered none of the known GAIA queries');
    log(`GAIA probe answered on "${transport.deviceName}" (spp-style, 0x${answered.toString(16).padStart(4, '0')})`);
  } catch (e) {
    const first = (e as Error).message;
    log(`no spp-style answer (${first}); trying gatt-v3 framing...`);
    client.retryWithFraming('gatt-v3');
    try {
      const answered = await client.tryCommands(gateCommands);
      if (answered === null) throw new Error('device answered none of the known GAIA queries');
      log(`GAIA probe answered on "${transport.deviceName}" (gatt-v3, 0x${answered.toString(16).padStart(4, '0')})`);
      (transport as { framing: Framing }).framing = 'gatt-v3';
      client.setActiveFraming('gatt-v3');
    } catch (e2) {
      const second = (e2 as Error).message;
      const detail = closed !== null ? ` channel had closed: ${closed}` : '';
      session.close();
      throw new Error(`socket opened but the device answered no GAIA command (spp-style: ${first}; gatt-v3: ${second}).${detail}`);
    }
  }

  if (closed !== null) {
    session.close();
    throw new Error(`channel closed right after the GAIA probe: ${closed}`);
  }

  return { client, session: transport };
}
