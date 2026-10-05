'use client';

/**
 * Headphone session: React state + high-level operations on top of GaiaClient.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GaiaClient } from './gaia-client';
import { GaiaPacket, hex } from './gaia';
import { isTauri } from './tauri-bridge';
import { connectTauri, TransportSession } from './transport';
import { APP_VERSION } from '../version';
import {
  AncModes,
  audioModePayload,
  batteryQuery,
  booleanPayload,
  CMD,
  eqBandPayload,
  eqBandQuery,
  EqConfig,
  expectedResponse,
  parseAncModes,
  parseBattery,
  parseBtCompatMode,
  parseBoolean,
  parseEqBand,
  parseEqConfig,
  parseLevel100,
  parseSoundMode,
  setAncEnabledPayload,
  setAncModePayload,
  ANC_MODE,
  SOUND_MODE,
  transparencyLevelPayload,
} from './sennheiser';

export type NoiseMode = 'off' | 'anc' | 'adaptive' | 'transparency';

export interface Snapshot {
  battery: number | null;
  ancEnabled: boolean | null;
  ancModes: AncModes | null;
  transparencyLevel: number | null;
  transparentHearing: boolean | null;
  eqConfig: EqConfig | null;
  eqBands: number[] | null;
  bassBoost: boolean | null;
  soundMode: number | null;
}

export interface ProtocolLine {
  t: number;
  dir: 'tx' | 'rx' | 'info' | 'err';
  text: string;
}

const EMPTY_SNAPSHOT: Snapshot = {
  battery: null,
  ancEnabled: null,
  ancModes: null,
  transparencyLevel: null,
  transparentHearing: null,
  eqConfig: null,
  eqBands: null,
  bassBoost: null,
  soundMode: null,
};

export function currentNoiseMode(s: Snapshot): NoiseMode | null {
  if (s.ancEnabled === null) return null;
  if (s.transparentHearing) return 'transparency';
  if (!s.ancEnabled) return 'off';
  if (s.ancModes?.adaptiveEnabled) return 'adaptive';
  return (s.transparencyLevel ?? 0) > 0 ? 'transparency' : 'anc';
}

export function useHeadphones() {
  const clientRef = useRef<GaiaClient | null>(null);
  const tauriSessionRef = useRef<TransportSession | null>(null);
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [framing, setFraming] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<ProtocolLine[]>([]);
  const protocolRef = useRef<ProtocolLine[]>([]);

  const log = useCallback((dir: ProtocolLine['dir'], text: string) => {
    const line: ProtocolLine = { t: Date.now(), dir, text };
    protocolRef.current = [...protocolRef.current.slice(-399), line];
    setProtocol(protocolRef.current);
  }, []);

  useEffect(() => {
    return () => clientRef.current?.disconnect();
  }, []);

  const applyPacket = useCallback((packet: GaiaPacket) => {
    // Update state from response/notification payloads we recognize.
    setSnapshot((prev) => {
      const next = { ...prev };
      const p = packet.payload;
      switch (packet.command) {
        case expectedResponse(CMD.getBattery): {
          const r = parseBattery(p);
          if (r.ok) next.battery = r.value;
          break;
        }
        case expectedResponse(CMD.getAncEnabled): {
          const r = parseBoolean(p);
          if (r.ok) next.ancEnabled = r.value;
          break;
        }
        case expectedResponse(CMD.getAncModes): {
          const r = parseAncModes(p);
          if (r.ok) next.ancModes = r.value;
          break;
        }
        case expectedResponse(CMD.getTransparencyLevel): {
          const r = parseLevel100(p);
          if (r.ok) next.transparencyLevel = r.value;
          break;
        }
        case expectedResponse(CMD.getTransparentHearing): {
          const r = parseBoolean(p);
          if (r.ok) next.transparentHearing = r.value;
          break;
        }
        case expectedResponse(CMD.getEqConfig): {
          const r = parseEqConfig(p);
          if (r.ok) next.eqConfig = r.value;
          break;
        }
        case expectedResponse(CMD.getBassBoost): {
          const r = parseBoolean(p);
          if (r.ok) next.bassBoost = r.value;
          break;
        }
        case expectedResponse(CMD.getSoundMode): {
          const r = parseSoundMode(p);
          if (r.ok) next.soundMode = r.value;
          break;
        }
        default:
          break;
      }
      return next;
    });
  }, []);

  const connect = useCallback(
    async (showAllDevices = false) => {
      setError(null);
      setStatus('connecting');
      protocolRef.current = [];
      log('info', `Smart Connect v${APP_VERSION} — ${isTauri() ? 'desktop (Bluetooth Classic RFCOMM)' : 'browser (Web Bluetooth)'}`);

      // Desktop (Tauri): Bluetooth Classic RFCOMM via the Rust backend.
      // The GAIA protocol layer is identical; only the byte pipe differs.
      if (isTauri()) {
        try {
          const { client, session } = await connectTauri((text) => {
            const isTx = text.startsWith('TX ');
            const isRx = text.startsWith('RX ');
            log(isTx ? 'tx' : isRx ? 'rx' : 'info', text);
          });
          client.onNotification = (packet) => applyPacket(packet);
          client.onDisconnected = () => {
            tauriSessionRef.current = null;
            setStatus('disconnected');
            setDeviceName(null);
            setFraming(null);
            log('err', 'disconnected');
          };
          clientRef.current = client;
          tauriSessionRef.current = session;
          setDeviceName(session.deviceName);
          setFraming(session.framing);
          setStatus('connected');
          await refreshSnapshot();
        } catch (e) {
          setStatus('disconnected');
          setError(describeError(e));
          log('err', `connect failed: ${(e as Error).message}`);
        }
        return;
      }

      // Browser: Web Bluetooth.
      const client = new GaiaClient((text) => {
        const isTx = text.startsWith('TX ');
        const isRx = text.startsWith('RX ');
        log(isTx ? 'tx' : isRx ? 'rx' : 'info', text);
      });
      client.onNotification = (packet) => applyPacket(packet);
      client.onDisconnected = () => {
        setStatus('disconnected');
        setDeviceName(null);
        setFraming(null);
        log('err', 'disconnected');
      };
      clientRef.current = client;
      try {
        const name = await client.connect({ showAllDevices });
        setDeviceName(name);
        setFraming(client.activeFraming);
        setStatus('connected');
        await refreshSnapshot();
      } catch (e) {
        setStatus('disconnected');
        setError(describeError(e));
        log('err', `connect failed: ${(e as Error).message}`);
        clientRef.current?.disconnect();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyPacket, log],
  );

  const disconnect = useCallback(() => {
    tauriSessionRef.current?.close();
    tauriSessionRef.current = null;
    clientRef.current?.disconnect();
    setStatus('disconnected');
    setDeviceName(null);
    setFraming(null);
  }, []);

  /** Serialized command runner with read-back after the write sequence. */
  const run = useCallback(
    async (fn: (client: GaiaClient) => Promise<void>) => {
      const client = clientRef.current;
      if (!client || !client.connected) throw new Error('not connected');
      setBusy(true);
      setError(null);
      try {
        await fn(client);
        await readSnapshotInto(client, setSnapshot, log);
      } catch (e) {
        setError(describeError(e));
        log('err', `operation failed: ${(e as Error).message}`);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [log],
  );

  const refreshSnapshot = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !client.connected) return;
    setBusy(true);
    try {
      await readSnapshotInto(client, setSnapshot, log);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // ------------------------------------------------------------------
  // High-level operations
  // ------------------------------------------------------------------

  const setNoiseMode = useCallback(
    async (mode: NoiseMode, transparencyLevel = 100) => {
      await run(async (client) => {
        switch (mode) {
          case 'off':
            await client.exchange(CMD.setTransparentHearing, booleanPayload(false));
            await client.exchange(CMD.setAncEnabled, setAncEnabledPayload(false));
            break;
          case 'anc':
            // Manual max ANC: TH off, ANC on, adaptive off, balance 0.
            await client.exchange(CMD.setTransparentHearing, booleanPayload(false));
            await client.exchange(CMD.setAncEnabled, setAncEnabledPayload(true));
            await client.exchange(CMD.setAncMode, setAncModePayload(ANC_MODE.adaptive, 0));
            await client.exchange(CMD.setTransparencyLevel, transparencyLevelPayload(0));
            break;
          case 'adaptive':
            await client.exchange(CMD.setTransparentHearing, booleanPayload(false));
            await client.exchange(CMD.setAncEnabled, setAncEnabledPayload(true));
            await client.exchange(CMD.setAncMode, setAncModePayload(ANC_MODE.adaptive, 1));
            break;
          case 'transparency':
            await client.exchange(CMD.setTransparentHearing, booleanPayload(false));
            await client.exchange(CMD.setAncMode, setAncModePayload(ANC_MODE.adaptive, 0));
            await client.exchange(CMD.setTransparencyLevel, transparencyLevelPayload(transparencyLevel));
            break;
        }
      });
    },
    [run],
  );

  const setTransparencyLevel = useCallback(
    async (level: number) => {
      await run(async (client) => {
        await client.exchange(CMD.setTransparencyLevel, transparencyLevelPayload(level));
      });
    },
    [run],
  );

  const setEqBand = useCallback(
    async (band: number, gainDb: number) => {
      await run(async (client) => {
        setSnapshot((prev) => {
          if (!prev.eqBands || !prev.eqConfig) return prev;
          const bands = [...prev.eqBands];
          bands[band] = gainDb;
          return { ...prev, eqBands: bands };
        });
        const cfg = await exchangeJson(client, CMD.getEqConfig, new Uint8Array(0), parseEqConfig);
        await client.exchange(CMD.setEqBand, eqBandPayload(band, gainDb, cfg.minGainDb, cfg.maxGainDb));
      });
    },
    [run],
  );

  const setEqBands = useCallback(
    async (gains: number[]) => {
      await run(async (client) => {
        const cfg = await exchangeJson(client, CMD.getEqConfig, new Uint8Array(0), parseEqConfig);
        for (let band = 0; band < Math.min(gains.length, cfg.bandCount); band++) {
          await client.exchange(CMD.setEqBand, eqBandPayload(band, gains[band], cfg.minGainDb, cfg.maxGainDb));
        }
      });
    },
    [run],
  );

  const setBassBoost = useCallback(
    async (enabled: boolean) => {
      await run(async (client) => {
        await client.exchange(CMD.setBassBoost, booleanPayload(enabled));
      });
    },
    [run],
  );

  const setSoundMode = useCallback(
    async (mode: number) => {
      await run(async (client) => {
        await client.exchange(CMD.setAudioMode, audioModePayload(mode));
      });
    },
    [run],
  );

  const refreshBattery = useCallback(async () => {
    await run(async (client) => {
      await client.exchange(CMD.getBattery, batteryQuery());
    });
  }, [run]);

  const mode = currentNoiseMode(snapshot);

  return useMemo(
    () => ({
      status,
      deviceName,
      framing,
      snapshot,
      mode,
      busy,
      error,
      protocol,
      connect,
      disconnect,
      refreshSnapshot,
      refreshBattery,
      setNoiseMode,
      setTransparencyLevel,
      setEqBand,
      setEqBands,
      setBassBoost,
      setSoundMode,
      clearError: () => setError(null),
      webBluetoothSupported: typeof navigator !== 'undefined' && !!navigator.bluetooth,
    }),
    [status, deviceName, framing, snapshot, mode, busy, error, protocol, connect, disconnect, refreshSnapshot, refreshBattery, setNoiseMode, setTransparencyLevel, setEqBand, setEqBands, setBassBoost, setSoundMode],
  );
}

// ---------------------------------------------------------------------------

async function readSnapshotInto(
  client: GaiaClient,
  set: (fn: (prev: Snapshot) => Snapshot) => void,
  log?: (dir: ProtocolLine['dir'], text: string) => void,
): Promise<void> {
  const next: Partial<Snapshot> = {};

  const readNum = async (label: string, command: number, payload: Uint8Array, parse: (p: Uint8Array) => ParseResult<number>) => {
    try {
      const v = await exchangeMaybeN(client, command, payload, parse);
      if (v === null) log?.('info', `   read ${label}: device gave no usable answer`);
      return v;
    } catch (e) {
      log?.('err', `   read ${label} failed: ${(e as Error).message}`);
      return null;
    }
  };
  const readBool = async (label: string, command: number) => {
    try {
      const v = await exchangeMaybeB(client, command, new Uint8Array(0));
      if (v === null) log?.('info', `   read ${label}: device gave no usable answer`);
      return v;
    } catch (e) {
      log?.('err', `   read ${label} failed: ${(e as Error).message}`);
      return null;
    }
  };
  const readJson = async <T,>(label: string, command: number, parse: (p: Uint8Array) => ParseResult<T>) => {
    try {
      const v = await exchangeMaybeJson(client, command, new Uint8Array(0), parse);
      if (!v) log?.('info', `   read ${label}: device gave no usable answer`);
      return v;
    } catch (e) {
      log?.('err', `   read ${label} failed: ${(e as Error).message}`);
      return null;
    }
  };

  const battery = await readNum('battery', CMD.getBattery, batteryQuery(), parseBattery);
  if (battery !== null) next.battery = battery;

  const ancEnabled = await readBool('ancEnabled', CMD.getAncEnabled);
  if (ancEnabled !== null) next.ancEnabled = ancEnabled;

  const modes = await readJson('ancModes', CMD.getAncModes, parseAncModes);
  if (modes) next.ancModes = modes;

  const level = await readNum('transparencyLevel', CMD.getTransparencyLevel, new Uint8Array(0), parseLevel100);
  if (level !== null) next.transparencyLevel = level;

  const th = await readBool('transparentHearing', CMD.getTransparentHearing);
  if (th !== null) next.transparentHearing = th;

  const soundMode = await readNum('soundMode', CMD.getSoundMode, new Uint8Array(0), parseSoundMode);
  if (soundMode !== null) next.soundMode = soundMode;

  await readNum('btCompatMode', CMD.getBtCompatMode, new Uint8Array(0), parseBtCompatMode); // read for the protocol log

  const eqConfig = await readJson('eqConfig', CMD.getEqConfig, parseEqConfig);
  if (eqConfig) {
    next.eqConfig = eqConfig;
    const bands: number[] = [];
    for (let band = 0; band < eqConfig.bandCount; band++) {
      const gain = await readNum(`eqBand${band}`, CMD.getEqBand, eqBandQuery(band), (p) => parseEqBand(p, band));
      bands.push(gain ?? 0);
    }
    next.eqBands = bands;
  }

  const bass = await readBool('bassBoost', CMD.getBassBoost);
  if (bass !== null) next.bassBoost = bass;

  set((prev) => ({ ...prev, ...next }));
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function exchangeMaybeN(
  client: GaiaClient,
  command: number,
  payload: Uint8Array,
  parse: (p: Uint8Array) => ParseResult<number>,
): Promise<number | null> {
  try {
    const packet = await client.exchange(command, payload);
    const r = parse(packet.payload);
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

async function exchangeMaybeB(
  client: GaiaClient,
  command: number,
  payload: Uint8Array,
): Promise<boolean | null> {
  try {
    const packet = await client.exchange(command, payload);
    const r = parseBoolean(packet.payload);
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

async function exchangeMaybeJson<T>(
  client: GaiaClient,
  command: number,
  payload: Uint8Array,
  parse: (p: Uint8Array) => ParseResult<T>,
): Promise<T | null> {
  try {
    const packet = await client.exchange(command, payload);
    const r = parse(packet.payload);
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

async function exchangeJson<T>(
  client: GaiaClient,
  command: number,
  payload: Uint8Array,
  parse: (p: Uint8Array) => { ok: true; value: T } | { ok: false; error: string },
): Promise<T> {
  const packet = await client.exchange(command, payload);
  const r = parse(packet.payload);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function describeError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/GATT|disconnect/i.test(msg)) return `${msg} — the headphones may have dropped the link. Reconnect and retry.`;
  return msg;
}

export function bytesToHex(data: Uint8Array): string {
  return hex(data);
}
