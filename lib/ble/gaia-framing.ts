/**
 * GAIA over BLE GATT framing.
 *
 * Web Bluetooth can only reach the BLE GAIA service. The RFCOMM transport used
 * by the reference projects wraps each GAIA packet in an SPP frame
 * (FF 03|04 lenHi lenLo). GAIA v3 over GATT instead uses a small header with
 * version/flags and sequence number, and fragments long payloads.
 *
 * Because the Sennheiser BLE implementation is not publicly documented, this
 * module implements both candidate framings and the client probes the device
 * at connect time (battery query), picking whichever framing yields a valid
 * GAIA packet with vendor id 0x0495. Every RX byte is logged to the UI console.
 */

import { decodePacket, GaiaPacket, hex } from './gaia';

export const GAIA_SERVICE_UUID = 0xfcd7; // 0000fcd7-... primary GAIA service (some stacks advertise f6cd/f6ce inside)
export const GAIA_DATA_V3_V2 = 'f6ce'; // GAIA v3 / v2 data endpoint (TX + notifications)
export const GAIA_DATA_V1 = 'f6cd'; // GAIA v1 data endpoint (legacy)
export const GAIA_COMMAND_TRIGGER = 'f6cf'; // write-only trigger characteristic

/**
 * Every BLE service UUID we may need to touch, whitelisted so Chrome's Web
 * Bluetooth implementation will expose them after requestDevice(). Chrome
 * HIDES any service not listed here — if the GAIA service lives under a UUID
 * absent from this list, getPrimaryServices() returns nothing and Chrome
 * reports "No Services found in device".
 */
export const KNOWN_SERVICE_UUIDS = [
  GAIA_SERVICE_UUID, // 0xfcd7 — Qualcomm GAIA
  0xfcf7, // alternative GAIA service seen on some stacks
  0xfcfe, // Sennheiser TWS BLE service (Smart Control companion service)
  0xfdff, // Sennheiser BTD 800 / dialog service family
  0xfe59, // Nordic DFU/OpenSK style service (harmless to whitelist)
  'battery_service',
  'device_information',
] as const;

/** GAIA v3 packet-type bits for the fragmentation header flags. */
export const GAIA_PACKET_FORMAT_VERSION = 0b10; // v3
const FLAG_START = 0b00000001;
const FLAG_CONTINUE = 0b00000010;
const FLAG_END = 0b00000100;

export type Framing = 'gatt-v3' | 'spp-style';

export interface FramedPacket {
  bytes: Uint8Array;
  framing: Framing;
}

/** Build the bytes to write for one GAIA packet in the given framing. */
export function framePacket(packet: GaiaPacket, framing: Framing, sequence: number): FramedPacket {
  if (framing === 'spp-style') {
    // FF 03 lenHi lenLo <vendorId:2> <command:2> <payload>   (len = payload length only)
    const body = encode(packet);
    const out = new Uint8Array(4 + body.length);
    out[0] = 0xff;
    out[1] = 0x03;
    out[2] = (packet.payload.length >> 8) & 0xff;
    out[3] = packet.payload.length & 0xff;
    out.set(body, 4);
    return { bytes: out, framing };
  }

  // GAIA v3 GATT: [version<<6 | flags] [sequence] [lenHi] [lenLo] [vendor id 2][command 2][payload]
  // Unfragmented: flags = START | END.
  const flags = FLAG_START | FLAG_END;
  const head = ((GAIA_PACKET_FORMAT_VERSION << 6) | flags) & 0xff;
  const body = packetLengthPrefixed(packet);
  const out = new Uint8Array(2 + body.length);
  out[0] = head;
  out[1] = sequence & 0xff;
  out.set(body, 2);
  return { bytes: out, framing };
}

function packetLengthPrefixed(packet: GaiaPacket): Uint8Array {
  // GAIA v3 packets on the wire carry a 2-byte BE payload length before the
  // vendor id in both framings seen in captures.
  const out = new Uint8Array(2 + 4 + packet.payload.length);
  out[0] = (packet.payload.length >> 8) & 0xff;
  out[1] = packet.payload.length & 0xff;
  out.set(encode(packet), 2);
  return out;
}

function encode(packet: GaiaPacket): Uint8Array {
  const out = new Uint8Array(4 + packet.payload.length);
  out[0] = (packet.vendorId >> 8) & 0xff;
  out[1] = packet.vendorId & 0x00ff;
  out[2] = (packet.command >> 8) & 0xff;
  out[3] = commandLow(packet.command);
  out.set(packet.payload, 4);
  return out;
}

function commandLow(command: number): number {
  return command & 0xff;
}

/**
 * Ingest RX bytes, attempting to decode GAIA packets under either framing.
 * Returns every decodable packet plus a human-readable reason when a chunk
 * could not be parsed (shown in the protocol console to aid debugging).
 */
export function decodeStream(chunk: Uint8Array, state: DecodeState): { packets: GaiaPacket[]; notes: string[] } {
  const notes: string[] = [];
  const packets: GaiaPacket[] = [];
  state.buffer.push(...chunk);

  while (state.buffer.length > 0) {
    // Try SPP-style first: find FF 03|04 sync marker.
    const syncIdx = findSync(state.buffer);
    if (syncIdx > 0) {
      state.buffer.splice(0, syncIdx);
    }

    // A lone trailing 0xFF is the START of a frame whose continuation is in
    // the next chunk. It must be retained: dropping it desyncs the stream
    // and cascades into every later frame (observed live on the M4 RFCOMM
    // link, where chunk boundaries split frames constantly).
    if (state.buffer.length === 1 && state.buffer[0] === 0xff) break;

    if (state.buffer.length >= 2 && state.buffer[0] === 0xff && (state.buffer[1] === 0x03 || state.buffer[1] === 0x04)) {
      if (state.buffer.length < 4) break; // wait for length bytes
      const len = (state.buffer[2] << 8) | state.buffer[3];
      // length field counts payload only; frame = sync(2) + len(2) + header(4) + payload(len)
      const totalFrame = 8 + len;
      if (state.buffer.length < totalFrame) break;
      const frame = state.buffer.splice(0, totalFrame);
      try {
        packets.push(decodePacket(new Uint8Array(frame.slice(4))));
      } catch (e) {
        notes.push(`spp decode failed: ${(e as Error).message} [${hex(frame)}]`);
      }
      continue;
    }

    // Try GAIA v3 GATT framing: [ver/flags][seq][lenHi][lenLo][vendor 2][cmd 2][payload]
    if (state.buffer.length >= 1 && (state.buffer[0] >> 6) === 0b10) {
      if (state.buffer.length < 4) break;
      const len = (state.buffer[2] << 8) | state.buffer[3];
      // header(4) + GAIA packet(4 + payload len)
      const total = 8 + len;
      if (state.buffer.length < total) break;
      const frame = state.buffer.splice(0, total);
      try {
        packets.push(decodePacket(new Uint8Array(frame.slice(4))));
      } catch (e) {
        notes.push(`v3 decode failed: ${(e as Error).message} [${hex(frame)}]`);
      }
      continue;
    }

    // Nothing matched: drop the first byte with a note (bounded to avoid spam).
    const dropped = state.buffer.shift() as number;
    notes.push(`no framing match, dropped ${dropped.toString(16).padStart(2, '0').toUpperCase()}`);
  }

  return { packets, notes };
}

export interface DecodeState {
  buffer: number[];
}

export function newDecodeState(): DecodeState {
  return { buffer: [] };
}

function findSync(buffer: number[]): number {
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] === 0xff && (buffer[i + 1] === 0x03 || buffer[i + 1] === 0x04)) return i;
  }
  return -1;
}
