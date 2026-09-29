'use client';

/**
 * Client-side profile persistence (localStorage).
 * Profiles capture noise mode, transparency level, EQ curve, bass boost and
 * sound mode; applying a profile pushes it to the connected headphones.
 */

import { NoiseMode, Snapshot } from './ble/use-headphones';

export interface HeadphoneProfile {
  id: string;
  name: string;
  createdAt: number;
  noiseMode: NoiseMode;
  transparencyLevel: number;
  eqBands: number[] | null;
  eqConfig: { bandCount: number; minGainDb: number; maxGainDb: number } | null;
  bassBoost: boolean;
  soundMode: number | null;
}

const KEY = 'smart-connect-bt-audio.profiles.v1';

export function loadProfiles(): HeadphoneProfile[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HeadphoneProfile[]) : [];
  } catch {
    return [];
  }
}

export function saveProfiles(profiles: HeadphoneProfile[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(KEY, JSON.stringify(profiles));
}

export function profileFromSnapshot(name: string, snapshot: Snapshot, mode: NoiseMode): HeadphoneProfile {
  return {
    id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    createdAt: Date.now(),
    noiseMode: mode ?? 'anc',
    transparencyLevel: snapshot.transparencyLevel ?? 100,
    eqBands: snapshot.eqBands ? [...snapshot.eqBands] : null,
    eqConfig: snapshot.eqConfig ? { ...snapshot.eqConfig } : null,
    bassBoost: snapshot.bassBoost ?? false,
    soundMode: snapshot.soundMode,
  };
}
