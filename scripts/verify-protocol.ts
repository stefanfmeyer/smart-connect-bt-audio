/**
 * Protocol logic verification (no hardware needed).
 * Run: npx tsx scripts/verify-protocol.ts
 * Exits non-zero on any failure.
 */

import { decodePacket, hex, packetType, responseFor, VENDOR_ID } from '../lib/ble/gaia';
import { decodeStream, framePacket, newDecodeState } from '../lib/ble/gaia-framing';
import {
  ANC_MODE,
  audioModePayload,
  eqBandPayload,
  parseAncModes,
  parseBattery,
  parseBoolean,
  parseEqBand,
  parseEqConfig,
  parseLevel100,
  parseSoundMode,
} from '../lib/ble/sennheiser';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('framing: SPP-style round trip');
{
  const packet = { vendorId: VENDOR_ID, command: 0x0603, payload: new Uint8Array(0) };
  const framed = framePacket(packet, 'spp-style', 0);
  // Expected shape from captured MTW4 traffic: FF 03 00 00 04 95 06 03
  check('battery query frame bytes', hex(framed.bytes) === 'FF 03 00 00 04 95 06 03', hex(framed.bytes));

  const state = newDecodeState();
  const { packets } = decodeStream(framed.bytes, state);
  check('round trip decodes 1 packet', packets.length === 1);
  check('command id preserved', packets[0]?.command === 0x0603);
  check('vendor preserved', packets[0]?.vendorId === VENDOR_ID);
}

console.log('framing: GATT v3 round trip');
{
  const packet = { vendorId: VENDOR_ID, command: 0x1a00, payload: new Uint8Array([0x03, 0x01]) };
  const framed = framePacket(packet, 'gatt-v3', 5);
  // 85 = version(10)<<6 | start|end flags(101); 05 seq; 00 02 len; 04 95 1a 00 03 01
  check('v3 frame bytes', hex(framed.bytes) === '85 05 00 02 04 95 1A 00 03 01', hex(framed.bytes));

  const state = newDecodeState();
  const { packets } = decodeStream(framed.bytes, state);
  check('round trip decodes 1 packet', packets.length === 1);
  check('command preserved', packets[0]?.command === 0x1a00);
  check('payload preserved', hex(packets[0]?.payload ?? []) === '03 01');
}

console.log('framing: captured response chunk (MTW4 battery)');
{
  // From sandrolucy capture: FF 04 00 03 04 95 06 83 50 50 3C  (L=80 R=80 case=60)
  const chunk = new Uint8Array([0xff, 0x04, 0x00, 0x03, 0x04, 0x95, 0x06, 0x83, 0x50, 0x50, 0x3c]);
  const state = newDecodeState();
  const { packets } = decodeStream(chunk, state);
  check('notification decodes', packets.length === 1, `got ${packets.length}`);
  const p = packets[0];
  check('notification id 0x0683', p?.command === 0x0683, p ? `0x${p.command.toString(16)}` : 'none');
  check('notification type', packetType(p!.command) === 'notification');
  check('battery payload L=80', p?.payload[0] === 0x50);
}

console.log('framing: split across two notifications');
{
  const full = [0xff, 0x04, 0x00, 0x01, 0x04, 0x95, 0x07, 0x03, 0x64];
  const state = newDecodeState();
  const first = decodeStream(new Uint8Array(full.slice(0, 5)), state);
  const second = decodeStream(new Uint8Array(full.slice(5)), state);
  const all = [...first.packets, ...second.packets];
  check('reassembled across chunks', all.length === 1, `got ${all.length}`);
  check('battery response id', all[0]?.command === 0x0703);
  const r = parseBattery(all[0]?.payload ?? new Uint8Array(0));
  check('battery parses 100%', r.ok && r.value === 100);
}

console.log('payloads: EQ band encode');
{
  const bytes = eqBandPayload(2, -3.5, -10, 10);
  check('eq band index+gain', hex(bytes) === '02 DD', hex(bytes)); // -35 tenths = 0xDD

  const roundTrip = parseEqBand(new Uint8Array([0x02, 0xdd]), 2);
  check('eq band parse round trip', roundTrip.ok && roundTrip.value === -3.5, JSON.stringify(roundTrip));

  // clamp check
  const clamped = eqBandPayload(0, 99, -10, 10);
  check('eq gain clamped to max', hex(clamped) === '00 64', hex(clamped));
}

console.log('payloads: EQ config parse');
{
  // bandCount=5, min=-100 tenths (-10dB), max=+100 tenths (+10dB)
  const r = parseEqConfig(new Uint8Array([0x05, 0x9c, 0x64]));
  check('eq config parsed', r.ok && r.value!.bandCount === 5 && r.value!.minGainDb === -10 && r.value!.maxGainDb === 10, JSON.stringify(r));
}

console.log('payloads: ANC modes parse');
{
  const r = parseAncModes(new Uint8Array([ANC_MODE.antiWind, 0, ANC_MODE.comfort, 1, ANC_MODE.adaptive, 1]));
  check('anc modes parsed', r.ok && r.value!.adaptiveEnabled === true && r.value!.comfortEnabled === true && r.value!.antiWind === 0, JSON.stringify(r));
  const bad = parseAncModes(new Uint8Array([0x01]));
  check('odd-length anc modes rejected', !bad.ok);
}

console.log('misc: response ids and error detection');
{
  check('0x0603 -> 0x0703', responseFor(0x0603) === 0x0703);
  check('0x1a00 -> 0x1b00', responseFor(0x1a00) === 0x1b00);
  check('0x1b80 is error', packetType(0x1b80) === 'error');
  check('0x1b00 is response', packetType(0x1b00) === 'response');
  const rejection = decodePacket(new Uint8Array([0x04, 0x95, 0x1b, 0x80, 0x02]));
  check('error packet decodes', rejection.command === 0x1b80);
}

console.log('misc: transparency level');
{
  const r = parseLevel100(new Uint8Array([0x32]));
  check('level 50 parsed', r.ok && r.value === 50);
  const over = parseLevel100(new Uint8Array([101]));
  check('level >100 rejected', !over.ok);
  const b = parseBoolean(new Uint8Array([1]));
  check('boolean true parsed', b.ok && b.value === true);
}

console.log('sound mode: M4 two-byte wire format');
{
  // Set (0x0803) must be [0x00, mode] on the M4 — a 1-byte payload is
  // rejected with GAIA error status 5 (was a live bug in v0.2.0).
  const p1 = audioModePayload(1);
  check('set Equalizer encodes 00 01', hex(p1) === '00 01', hex(p1));
  const p0 = audioModePayload(0);
  check('set Off encodes 00 00', hex(p0) === '00 00', hex(p0));
  const p3 = audioModePayload(3);
  check('set Sound Personalization encodes 00 03', hex(p3) === '00 03', hex(p3));

  // Get (0x0804) answers [0x00, mode]: parse must read byte 1.
  const r2 = parseSoundMode(new Uint8Array([0x00, 0x02]));
  check('2-byte response parses mode from byte 1', r2.ok && r2.value === 2);
  const r1 = parseSoundMode(new Uint8Array([0x02]));
  check('legacy 1-byte response still parses', r1.ok && r1.value === 2);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
