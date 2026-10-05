/**
 * Sennheiser command table + payload codecs.
 *
 * Command IDs verified against two independent MIT-licensed reverse-engineering
 * projects of the Sennheiser MOMENTUM 4:
 *   - m4-companion (Zhengyang-Liu), macOS, RFCOMM transport
 *   - OpenMomentum (ladybridgett), Android, RFCOMM transport
 * The GAIA command layer is transport-independent; this app carries it over
 * BLE GATT (Web Bluetooth) with runtime framing detection (see gaia-framing.ts).
 *
 * Byte layouts verified byte-for-byte against m4-companion MomentumControls.swift.
 */

import { payloadBytes, responseFor, u8 } from './gaia';

export const CMD = {
  // Device info / battery. NOTE (MOMENTUM 4): community RE of the M4 Classic
  // link (f3Y0/momentum4-control; SilentSoulsSr notes) documents NO battery
  // command, and the device silently IGNORES unknown queries like this one.
  // The connect gate therefore no longer waits for a battery answer (see
  // transport.ts connectOne); this read stays in the snapshot for models that
  // do answer it.
  getBattery: 0x0603, // -> 0x0703, payload [0..100]
  // Audio mode (Off / Equalizer / Podcast / Sound Personalization)
  setAudioMode: 0x0803, // payload [mode]
  getSoundMode: 0x0804, // -> 0x0904, payload [mode]
  // Bluetooth compatibility mode (0 better audio / 1 better compatibility)
  getBtCompatMode: 0x0406, // -> 0x0506, payload [mode]
  // Sound personalization profile state
  getSoundPersonalizationState: 0x2001, // -> 0x2101, payload [state]
  // ANC feature (0x1a..)
  setAncMode: 0x1a00, // payload [mode, state] e.g. [0x03, 0x01] adaptive on
  getAncModes: 0x1a01, // -> repeated [mode, state] pairs
  setTransparencyLevel: 0x1a02, // payload [0..100]
  getTransparencyLevel: 0x1a03, // -> 0x1b03 [0..100]
  setAncEnabled: 0x1a04, // payload [0|1]
  getAncEnabled: 0x1a05, // -> 0x1b05 [0|1]
  // Transparent hearing (feature 0x18..)
  setTransparentHearing: 0x1804, // payload [0|1]
  getTransparentHearing: 0x1805, // -> 0x1905 [0|1]
  // EQ (feature 0x10..)
  getEqConfig: 0x1000, // -> 0x1100 [bandCount, minGainTenths(s8), maxGainTenths(s8)]
  setEqBand: 0x1001, // payload [bandIndex, gainTenths(s8)]
  getEqBand: 0x1002, // payload [bandIndex] -> [bandIndex?, gainTenths]
  setBassBoost: 0x1008, // payload [0|1]
  getBassBoost: 0x1009, // -> 0x1109 [0|1]
} as const;

/** ANC sub-modes (payload byte for setAncMode / getAncModes pairs). */
export const ANC_MODE = {
  antiWind: 1,
  comfort: 2,
  adaptive: 3,
} as const;

/** Sound (audio) modes for setAudioMode / getSoundMode. */
export const SOUND_MODE = {
  off: 0,
  equalizer: 1,
  podcast: 2,
  soundPersonalization: 3,
} as const;

export const SOUND_MODE_NAMES: Record<number, string> = {
  [SOUND_MODE.off]: 'Off',
  [SOUND_MODE.equalizer]: 'Equalizer',
  [SOUND_MODE.podcast]: 'Podcast',
  [SOUND_MODE.soundPersonalization]: 'Sound Personalization',
};

export const BT_COMPAT_MODE_NAMES: Record<number, string> = {
  0: 'Better Audio (high resolution)',
  1: 'Better Compatibility',
};

export const SOUND_PERSONALIZATION_STATE_NAMES: Record<number, string> = {
  0: 'Not parameterized',
  1: 'Calibrating',
  2: 'Calibrated',
  3: 'Activation inhibited',
};

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

export function batteryQuery(): Uint8Array {
  return payloadBytes();
}

export function setAncEnabledPayload(enabled: boolean): Uint8Array {
  return payloadBytes(enabled ? 1 : 0);
}

export function setAncModePayload(mode: number, state: 0 | 1): Uint8Array {
  return payloadBytes(mode, state);
}

export function transparencyLevelPayload(level: number): Uint8Array {
  return payloadBytes(Math.min(100, Math.max(0, Math.round(level))));
}

export function booleanPayload(value: boolean): Uint8Array {
  return payloadBytes(value ? 1 : 0);
}

export function audioModePayload(mode: number): Uint8Array {
  // Sound-mode set (0x0803) takes [0x00, mode] on the M4 — byte 0 is always
  // 0. A 1-byte payload is rejected with GAIA error status 5 (verified live
  // and against the hardware-verified community client).
  return payloadBytes(0, mode);
}

export function eqBandQuery(band: number): Uint8Array {
  return payloadBytes(band);
}

/**
 * EQ band write: [bandIndex, gain in tenths of dB as signed byte].
 * Gain is clamped to the device-reported range.
 */
export function eqBandPayload(band: number, gainDb: number, minDb: number, maxDb: number): Uint8Array {
  const clamped = Math.min(maxDb, Math.max(minDb, gainDb));
  const tenths = Math.round(clamped * 10);
  if (tenths < -128 || tenths > 127) throw new RangeError(`EQ gain ${gainDb} dB out of device range`);
  return payloadBytes(band, tenths & 0xff);
}

// ---------------------------------------------------------------------------
// Response parsers (validate vendor id, response id, size, range)
// ---------------------------------------------------------------------------

export interface ParsedOk<T> {
  ok: true;
  value: T;
}
export interface ParsedErr {
  ok: false;
  error: string;
}
export type Parsed<T> = ParsedOk<T> | ParsedErr;

function err(error: string): ParsedErr {
  return { ok: false, error };
}

export function parseBattery(payload: Uint8Array): Parsed<number> {
  if (payload.length < 1) return err('battery payload empty');
  const v = payload[0];
  if (v > 100) return err(`battery percentage out of range: ${v}`);
  return { ok: true, value: v };
}

export function parseBoolean(payload: Uint8Array): Parsed<boolean> {
  if (payload.length < 1) return err('boolean payload empty');
  const v = payload[0];
  if (v > 1) return err(`invalid boolean: ${v}`);
  return { ok: true, value: v === 1 };
}

export function parseLevel100(payload: Uint8Array): Parsed<number> {
  if (payload.length < 1) return err('level payload empty');
  const v = payload[0];
  if (v > 100) return err(`level out of range: ${v}`);
  return { ok: true, value: v };
}

export function parseSoundMode(payload: Uint8Array): Parsed<number> {
  // The M4 carries the mode in a 2-byte payload [0x00, mode] (byte 0 is
  // always 0, community-verified on hardware); accept the 1-byte form other
  // Sennheiser models use, but prefer byte 1 when the 2-byte form arrives.
  if (payload.length >= 2) return { ok: true, value: payload[1] };
  if (payload.length < 1) return err('sound mode payload empty');
  return { ok: true, value: payload[0] };
}

export function parseBtCompatMode(payload: Uint8Array): Parsed<number> {
  if (payload.length < 1) return err('compat mode payload empty');
  return { ok: true, value: payload[0] };
}

export function parseSoundPersonalizationState(payload: Uint8Array): Parsed<number> {
  if (payload.length < 1) return err('profile state payload empty');
  return { ok: true, value: payload[0] };
}

export interface EqConfig {
  bandCount: number;
  minGainDb: number;
  maxGainDb: number;
}

export function parseEqConfig(payload: Uint8Array): Parsed<EqConfig> {
  if (payload.length < 3 || payload[0] === 0) return err('EQ config malformed');
  const min = asInt8(payload[1]) / 10;
  const max = asInt8(payload[2]) / 10;
  if (min > max) return err(`EQ config min>max (${min}/${max})`);
  return { ok: true, value: { bandCount: payload[0], minGainDb: min, maxGainDb: max } };
}

export function parseEqBand(payload: Uint8Array, requestedBand: number): Parsed<number> {
  if (payload.length < 1) return err('EQ band payload empty');
  let gainTenths: number;
  if (payload.length >= 2) {
    if (payload[0] !== requestedBand) return err(`EQ band echo mismatch (${payload[0]} != ${requestedBand})`);
    gainTenths = payload[1];
  } else {
    gainTenths = payload[0];
  }
  return { ok: true, value: asInt8(gainTenths) / 10 };
}

export interface AncModes {
  antiWind: number; // 0 off / 1 max / 2 auto
  comfortEnabled: boolean;
  adaptiveEnabled: boolean;
}

export function parseAncModes(payload: Uint8Array): Parsed<AncModes> {
  if (payload.length < 2 || payload.length % 2 !== 0) return err('ANC modes payload malformed');
  const out: AncModes = { antiWind: 0, comfortEnabled: false, adaptiveEnabled: false };
  for (let i = 0; i < payload.length; i += 2) {
    const mode = payload[i];
    const state = payload[i + 1];
    if (mode === ANC_MODE.antiWind) {
      if (state > 2) return err(`anti-wind state out of range: ${state}`);
      out.antiWind = state;
    } else if (mode === ANC_MODE.comfort) {
      if (state > 1) return err(`comfort state out of range: ${state}`);
      out.comfortEnabled = state === 1;
    } else if (mode === ANC_MODE.adaptive) {
      if (state > 1) return err(`adaptive state out of range: ${state}`);
      out.adaptiveEnabled = state === 1;
    }
  }
  return { ok: true, value: out };
}

function asInt8(b: number): number {
  return (b & 0x80) !== 0 ? b - 0x100 : b;
}

/** Expected response id for a request command (0x1a00 -> 0x1b00). */
export function expectedResponse(command: number): number {
  return responseFor(command);
}
