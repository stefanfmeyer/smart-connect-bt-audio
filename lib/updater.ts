/**
 * Auto-update for the desktop app (Tauri updater plugin, signed releases).
 *
 * Policy (product decision): fully automatic — on every desktop launch the
 * app checks the release manifest, and a newer signed build is downloaded,
 * verified against the bundled public key and installed without any user
 * interaction. If an RFCOMM session is active, the install is deferred to
 * the NEXT launch so a live headphone connection is never torn down
 * mid-flight.
 *
 * v0.1.7 is the first build that contains the updater: everyone on <= v0.1.6
 * updates to v0.1.7 manually once; every later release installs itself.
 */

import { isTauri } from './ble/tauri-bridge';
import { APP_VERSION } from './version';

export type UpdatePhase =
  | 'idle' // no update available (or browser build)
  | 'checking'
  | 'downloading'
  | 'ready' // downloaded but deferred (session was active); applies next launch
  | 'installing' // handed to the OS installer / relaunching
  | 'failed';

export interface UpdateState {
  phase: UpdatePhase;
  version: string | null; // version being downloaded / ready to install
  progress: number | null; // 0..100 while downloading
  error: string | null;
}

export const IDLE_UPDATE: UpdateState = { phase: 'idle', version: null, progress: null, error: null };

function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [cMaj, cMin, cPat] = parse(candidate);
  const [uMaj, uMin, uPat] = parse(current);
  return cMaj !== uMaj ? cMaj > uMaj : cMin !== uMin ? cMin > uMin : cPat > uPat;
}

/**
 * Fire-and-forget: checks and applies updates in the background, reporting
 * state transitions through `onEvent`. `isConnected()` lets the updater hold
 * off installing while a device session is live.
 */
export function startAutoUpdate(onEvent: (s: UpdateState) => void, isConnected: () => boolean): void {
  if (!isTauri()) return; // web build: no updater
  void (async () => {
    try {
      onEvent({ phase: 'checking', version: null, progress: null, error: null });
      const { check } = await import('@tauri-apps/plugin-updater');
      const { relaunch } = await import('@tauri-apps/plugin-process');
      const update = await check();
      if (!update || !isNewer(update.version, APP_VERSION)) {
        onEvent(IDLE_UPDATE);
        return;
      }

      // Active session: stage only, apply on next launch.
      if (isConnected()) {
        onEvent({ phase: 'ready', version: update.version, progress: null, error: null });
        return;
      }

      onEvent({ phase: 'downloading', version: update.version, progress: 0, error: null });
      let received = 0;
      let contentLength = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          received = 0;
          contentLength = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          const progress = contentLength > 0 ? Math.min(100, Math.round((received / contentLength) * 100)) : null;
          onEvent({ phase: 'downloading', version: update.version, progress, error: null });
        }
        // 'Finished': on Windows the NSIS installer takes over and the app
        // relaunches itself; relaunch() below is only a fallback.
      });

      onEvent({ phase: 'installing', version: update.version, progress: null, error: null });
      await relaunch();
    } catch (e) {
      // Non-fatal by design: a failed update must never break the app.
      onEvent({ phase: 'failed', version: null, progress: null, error: (e as Error).message ?? String(e) });
    }
  })();
}
