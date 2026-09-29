/**
 * GAIA protocol primitives.
 *
 * A GAIA packet is: vendorId (2B BE) | command (2B BE) | payload
 *
 * Sennheiser command numbering follows the GAIA V3 scheme:
 *   bits 15-9  feature (7 bits)
 *   bits 8-7   packet type (00 command, 01 notification, 10 response, 11 error)
 *   bits 6-0   command id
 * so requests/responses come in pairs such as 0x1a00 -> 0x1b00, and an
 * error response is the success response id with 0x0080 set (e.g. 0x1b80).
 *
 * Framings (see gaia-framing.ts):
 *  - RFCOMM (SPP): FF 03|04 lenHi lenLo <packet>
 *  - GAIA v3 over GATT adds a 2-byte header (version+flags, sequence) and
 *    fragments long payloads (start/continue/end).
 */

export const VENDOR_ID = 0x0495; // Qualcomm GAIA vendor id used by Sennheiser

export interface GaiaPacket {
  vendorId: number;
  command: number;
  payload: Uint8Array;
}

export function encodePacket(vendorId: number, command: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = (vendorId >> 8) & 0xff;
  out[1] = vendorId & 0xff;
  out[2] = (command >> 8) & 0xff;
  out[3] = command & 0xff;
  out.set(payload, 4);
  return out;
}

export function decodePacket(data: Uint8Array): GaiaPacket {
  if (data.length < 4) throw new Error(`GAIA packet shorter than 4 bytes (${data.length})`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    vendorId: dv.getUint16(0),
    command: dv.getUint16(2),
    payload: data.slice(4),
  };
}

export function packetType(command: number): 'command' | 'notification' | 'response' | 'error' {
  const t = (command >> 7) & 0b11;
  if (t === 0b00) return 'command';
  if (t === 0b01) return 'notification';
  if (t === 0b10) return 'response';
  return 'error';
}

export function responseFor(command: number): number {
  return (command | 0x0100) & 0xffff;
}

export function isErrorResponse(command: number): boolean {
  return packetType(command) === 'error';
}

export function u8(v: number): number {
  if (v < 0 || v > 255 || !Number.isFinite(v)) throw new RangeError(`byte out of range: ${v}`);
  return v & 0xff;
}

export function payloadBytes(...values: number[]): Uint8Array {
  return new Uint8Array(values.map(u8));
}

/** Append bytes to a growing payload. */
export function pushBytes(target: number[], ...values: number[]): void {
  for (const v of values) target.push(u8(v));
}

export function hex(data: Uint8Array | number[], sep = ' '): string {
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(sep);
}
