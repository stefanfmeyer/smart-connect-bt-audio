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

  // --- 6. tryCommands gate: battery-ignoring device (MOMENTUM 4 profile) -----
  {
    const client2 = new GaiaClient(() => undefined);
    client2.attachTransport({
      framing: 'spp-style',
      deviceName: 'mute-for-battery (simulated)',
      write: async (bytes) => {
        // Answer ONLY the ANC get (0x1A05 -> 0x1B05); ignore everything else.
        const hexed = hex(bytes).toLowerCase().replace(/ /g, '');
        if (hexed.endsWith('1a05')) {
          setTimeout(() => {
            client2.ingestTransportBytes(
              framePacket({ vendorId: 0x0495, command: 0x1b05, payload: new Uint8Array([1]) }, 'spp-style', 0).bytes,
            );
          }, 10);
        }
      },
      close: () => undefined,
    });
    const answered = await client2.tryCommands([0x0603, 0x1a05]);
    check('tryCommands skips ignored battery query, accepts ANC get', answered === 0x1a05, `got ${answered}`);
  }

  // --- 7. tryCommands gate: all-mute channel returns null --------------------
  {
    const client3 = new GaiaClient(() => undefined);
    client3.attachTransport({
      framing: 'spp-style',
      deviceName: 'all-mute (simulated)',
      write: async () => undefined,
      close: () => undefined,
    });
    const answered = await client3.tryCommands([0x0603]);
    check('tryCommands returns null when nothing is answered', answered === null, `got ${answered}`);
  }

  // --- 8. split frame: a chunk ending in a lone FF must be retained ----------
  // Observed live on the M4 RFCOMM link: the decoder dropped the leading FF,
  // desyncing the stream and cascading into "no usable answer" everywhere.
  {
    const client4 = new GaiaClient(() => undefined);
    let splitGot: GaiaPacket | null = null;
    client4.onNotification = (p) => {
      if (p.command === 0x1b05) splitGot = p;
    };
    client4.attachTransport({
      framing: 'spp-style',
      deviceName: 'split-chunk (simulated)',
      write: async () => undefined,
      close: () => undefined,
    });
    const frame = framePacket({ vendorId: 0x0495, command: 0x1b05, payload: new Uint8Array([1]) }, 'spp-style', 0).bytes;
    client4.ingestTransportBytes(frame.slice(0, 1)); // chunk ends right after FF
    client4.ingestTransportBytes(frame.slice(1)); // continuation arrives next
    await new Promise((r) => setTimeout(r, 10));
    check(
      'split frame across chunks decodes (lone FF retained)',
      splitGot !== null && (splitGot as GaiaPacket).payload[0] === 1,
    );
  }

  // --- 9. late response: parked after timeout, reused by next exchange -------
  // Observed live: the M4 answers correctly but after the exchange timed out;
  // the next exchange for the same id must resolve from the parked answer.
  {
    const client5 = new GaiaClient(() => undefined);
    client5.attachTransport({
      framing: 'spp-style',
      deviceName: 'slow-link (simulated)',
      write: async () => undefined,
      close: () => undefined,
    });
    const slow = client5.exchange(0x0603, new Uint8Array(0), 50);
    await new Promise((r) => setTimeout(r, 80)); // let the timeout fire
    let timedOut = false;
    await slow.catch((e: Error) => {
      timedOut = /timeout/.test(e.message);
    });
    check('first exchange times out on the slow link', timedOut);
    // The device's answer finally arrives -> no matching pending -> parked.
    client5.ingestTransportBytes(
      framePacket({ vendorId: 0x0495, command: 0x0703, payload: new Uint8Array([42]) }, 'spp-style', 0).bytes,
    );
    await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    const again = await client5.exchange(0x0603, new Uint8Array(0), 8000);
    check(
      'parked late response satisfies the next matching exchange instantly',
      again.payload[0] === 42 && Date.now() - t0 < 100,
      `payload=${hex(again.payload)} dt=${Date.now() - t0}ms`,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall desktop transport checks passed');
}

void main();
