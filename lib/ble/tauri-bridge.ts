/**
 * Tauri backend bridge (Windows RFCOMM transport).
 * The Rust side owns the Bluetooth Classic socket; this module is the thin
 * typed surface the frontend talks to.
 */

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

export interface GaiaDevice {
  id: string; // RfcommDeviceService instance id
  name: string; // device name
}

export interface TauriHandlers {
  onData: (bytes: Uint8Array) => void;
  onClose: () => void;
}

export interface TauriSession {
  write: (bytes: Uint8Array) => Promise<void>;
  close: () => void;
}

async function api() {
  const core = await import('@tauri-apps/api/core');
  const event = await import('@tauri-apps/api/event');
  return { invoke: core.invoke, listen: event.listen };
}

export async function listGaiaDevices(): Promise<GaiaDevice[]> {
  const { invoke } = await api();
  return invoke<GaiaDevice[]>('list_devices');
}

/**
 * Open the RFCOMM GAIA channel to the device and wire event listeners.
 * Resolves once the socket is connected; rejects with the backend error.
 */
export async function tauriConnect(deviceId: string, handlers: TauriHandlers): Promise<TauriSession & { deviceName: string }> {
  const { invoke, listen } = await api();

  let sessionActive = true;
  const unRx = await listen<number[]>('gaia-rx', (e) => {
    if (sessionActive && Array.isArray(e.payload)) handlers.onData(new Uint8Array(e.payload));
  });
  const unClose = await listen('gaia-closed', () => {
    if (!sessionActive) return;
    sessionActive = false;
    unRx();
    unClose();
    handlers.onClose();
  });

  try {
    const deviceName = await invoke<string>('gaia_connect', { deviceId, name: '' });
    return {
      deviceName: deviceName || 'headphones',
      write: async (bytes: Uint8Array) => {
        await invoke('gaia_write', { bytes: Array.from(bytes) });
      },
      close: () => {
        if (!sessionActive) return;
        sessionActive = false;
        unRx();
        unClose();
        invoke('gaia_disconnect').catch(() => undefined);
      },
    };
  } catch (e) {
    sessionActive = false;
    unRx();
    unClose();
    throw e;
  }
}
