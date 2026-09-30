/**
 * Desktop transport simulation: drives GaiaClient over a fake RFCOMM transport
 * (no Bluetooth, no Tauri) to verify the exact plumbing the Windows app uses:
 * attachTransport -> exchange() -> spp-framed TX -> ingestTransportBytes(RX)
 * -> response resolves. Also covers GAIA errors and battery notifications.
 *
 * Run: npx tsx scripts/verify-desktop-transport.ts
 */
import { GaiaClient } from '../lib/ble/gaia-client';
import { GaiaPacket, hex } from '../lib/ble/gaia';
import { framePacket } from '../lib/ble/gaia-framing';
import type { TransportSession } from '../lib/ble/transport';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    failures++;
    console.error(`  FAIL: ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function main() {
  const lines: string[] = [];
  const written: Uint8Array[] = [];

  const transport: TransportSession = {
    framing: 'spp-style',
    deviceName: 'MOMENTUM 4 (simulated)',
    write: async (bytes) => {
      written.push(bytes);
    },
    close: () => undefined,
  };

  const client = new GaiaClient((line) => lines.push(line));
  client.attachTransport(transport);

  check('client reports connected after attachTransport', client.connected);
  check('device name comes from transport', client.deviceName === 'MOMENTUM 4 (simulated)');
  check('framing is spp-style', client.activeFraming === 'spp-style');

  // --- 1. battery exchange: TX frame then spp-framed 0x0703 response ---------
  const exchange = client.exchange(0x0603, new Uint8Array(0), 2000);
  await new Promise((r) => setTimeout(r, 10));

  check('one frame written', written.length === 1, `got ${written.length}`);
  const tx = written[0];
  check(
    'TX is the spp-style battery query FF 03 00 00 04 95 06 03',
    !!tx && hex(tx).toLowerCase() === 'ff 03 00 00 04 95 06 03',
    tx ? hex(tx) : 'nothing',
  );

  const batteryResponse: GaiaPacket = { vendorId: 0x0495, command: 0x0703, payload: new Uint8Array([87]) };
  client.ingestTransportBytes(framePacket(batteryResponse, 'spp-style', 0).bytes);
  const resolved = await exchange;
  check('response resolves with command 0x0703', resolved.command === 0x0703);
  check('battery payload parsed through (87%)', resolved.payload[0] === 87);

  // --- 2. GAIA error response rejects the exchange ---------------------------
  // Error id = response id | 0x0080: getSoundMode 0x0804 -> response 0x0904 -> error 0x0984.
  try {
    const failing = client.exchange(0x0804, new Uint8Array(0), 2000);
    await new Promise((r) => setTimeout(r, 10));
    const errResponse: GaiaPacket = { vendorId: 0x0495, command: 0x0984, payload: new Uint8Array([1]) };
    client.ingestTransportBytes(framePacket(errResponse, 'spp-style', 1).bytes);
    await failing;
    check('GAIA error response rejects exchange', false, 'resolved instead');
  } catch (e) {
    check('GAIA error response rejects exchange', /GAIA error/.test((e as Error).message), (e as Error).message);
  }

  // --- 3. notifications surface through onNotification -----------------------
  let notified: GaiaPacket | null = null;
  client.onNotification = (p) => {
    if (p.command === 0x0683) notified = p;
  };
  const push: GaiaPacket = { vendorId: 0x0495, command: 0x0683, payload: new Uint8Array([64, 70, 0]) };
  client.ingestTransportBytes(framePacket(push, 'spp-style', 2).bytes);
  await new Promise((r) => setTimeout(r, 10));
  check('battery notification 0x0683 delivered', notified !== null && (notified as GaiaPacket).payload[0] === 64);

  // --- 4. transport close fails in-flight exchange and disconnects -----------
  let closeEvent: string | null = null;
  client.onDisconnected = () => {
    closeEvent = 'fired';
  };
  const inFlight = client.exchange(0x0603, new Uint8Array(0), 5000);
  await new Promise((r) => setTimeout(r, 10));
  client.handleTransportClosed();
  try {
    await inFlight;
    check('in-flight exchange rejects on transport close', false, 'resolved instead');
  } catch {
    check('in-flight exchange rejects on transport close', true);
  }
  check('onDisconnected fired on transport close', closeEvent === 'fired');
  check('client reports disconnected', !client.connected);

  // --- 5. protocol log saw TX/RX lines ---------------------------------------
  check('protocol log contains TX line', lines.some((l) => l.toLowerCase().startsWith('tx ff 03')));
  check('protocol log contains RX line', lines.some((l) => l.toLowerCase().startsWith('rx ff 03')));

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall desktop transport checks passed');
}

void main();
