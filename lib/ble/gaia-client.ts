/**
 * GAIA over Web Bluetooth client.
 *
 * Responsibilities:
 *  - open the BLE GAIA service and data characteristic
 *  - probe which wire framing the headset speaks (v3 GATT vs SPP-style)
 *  - serialize request/response exchanges (one outstanding command at a time)
 *  - surface every TX/RX to the protocol console
 */

import { decodePacket, encodePacket, GaiaPacket, hex, isErrorResponse, packetType, responseFor, VENDOR_ID } from './gaia';
import { decodeStream, framePacket, GAIA_DATA_V1, GAIA_DATA_V3_V2, GAIA_SERVICE_UUID, KNOWN_SERVICE_UUIDS, Framing, newDecodeState } from './gaia-framing';
import type { TransportSession } from './transport';

export type LogSink = (line: string) => void;

export class GaiaClient {
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private framing: Framing = 'gatt-v3';
  private sequence = 0;
  private decodeState = newDecodeState();
  private queue: Promise<unknown> = Promise.resolve();
  private pending: {
    command: number;
    resolve: (p: GaiaPacket) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private notificationHandler: ((e: Event) => void) | null = null;

  // Desktop (Tauri RFCOMM) transport. When set, all writes route through it,
  // RX bytes arrive via ingest(), and the Web Bluetooth fields stay unused.
  private transport: TransportSession | null = null;
  private transportOpen = false;

  constructor(private log: LogSink) {}

  get connected(): boolean {
    if (this.transport) return this.transportOpen;
    return this.device?.gatt?.connected ?? false;
  }

  get deviceName(): string {
    if (this.transport) return this.transport.deviceName;
    return this.device?.name ?? 'headphones';
  }

  get activeFraming(): Framing {
    return this.framing;
  }

  /**
   * Attach a non-BLE transport (desktop RFCOMM). After this, the client is
   * "connected": exchanges frame + write via the transport, responses arrive
   * through ingest() from the transport's RX hook.
   */
  attachTransport(session: TransportSession): void {
    this.transport = session;
    this.transportOpen = true;
    this.framing = session.framing;
    this.sequence = 0;
    this.decodeState = newDecodeState();
  }

  /** Transport dropped the link (unexpected close, not a local disconnect()). */
  handleTransportClosed(): void {
    if (!this.transportOpen) return;
    this.transportOpen = false;
    this.cleanupAfterDisconnect();
    this.onDisconnected?.();
  }

  /** RX bytes from the transport; public so the transport module can feed us. */
  ingestTransportBytes(bytes: Uint8Array): void {
    this.ingest(bytes);
  }

  async connect(options?: { showAllDevices?: boolean }): Promise<string> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available. Use Chrome/Edge on desktop over HTTPS or localhost.');
    }

    const showAll = options?.showAllDevices ?? false;
    if (showAll) {
      this.log('requesting device (showing ALL BLE devices)...');
    } else {
      this.log('requesting device (filters: Sennheiser name prefixes, GAIA service)...');
    }
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice(
        showAll
          ? { acceptAllDevices: true, optionalServices: [...KNOWN_SERVICE_UUIDS] }
          : {
              filters: [
                { services: [GAIA_SERVICE_UUID] },
                { namePrefix: 'Sennheiser' },
                { namePrefix: 'MOMENTUM' },
                { namePrefix: 'CX' },
                { namePrefix: 'HD ' },
                { namePrefix: 'ACCENTUM' },
              ],
              optionalServices: [...KNOWN_SERVICE_UUIDS],
            },
      );
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (/globally disabled/i.test(msg)) {
        throw new Error(
          'Web Bluetooth is switched off in this browser. In Chrome/Edge open chrome://flags (or edge://flags), search for Web Bluetooth, set it to Enabled and relaunch. On Linux also check chrome://settings/bluetooth. In Brave: Settings > Privacy > additional settings, or brave://flags/#enable-web-bluetooth. Firefox and Safari do not support Web Bluetooth at all.',
        );
      }
      if (/User cancelled|user denied|dismissed/i.test(msg)) {
        throw new Error('Device picker was closed without selecting headphones.');
      }
      throw new Error(`device picker failed: ${msg}`);
    }

    this.device = device;
    device.addEventListener('gattserverdisconnected', () => {
      this.log('!! GATT server disconnected');
      this.cleanupAfterDisconnect();
      this.onDisconnected?.();
    });

    this.log(`connecting GATT to "${device.name ?? device.id}"...`);
    const server = await device.gatt!.connect();
    this.log('GATT connected, enumerating services...');

    // Walk every whitelisted service and inventory its characteristics.
    // Chrome only exposes services listed in optionalServices; anything else
    // is invisible to us (and to the user in the picker).
    const services = await server.getPrimaryServices();
    this.log(`${services.length} service(s) visible to the browser`);
    const inventory: string[] = [];

    interface Candidate {
      service: BluetoothRemoteGATTService;
      char: BluetoothRemoteGATTCharacteristic;
      label: string;
    }
    const candidates: Candidate[] = [];
    let batteryChar: BluetoothRemoteGATTCharacteristic | null = null;

    for (const s of services) {
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        chars = await s.getCharacteristics();
      } catch {
        this.log(`  service ${s.uuid}: characteristics unreadable`);
        inventory.push(`${shortUuid(s.uuid)}[?]`);
        continue;
      }
      const charIds = chars.map((c) => `${shortUuid(c.uuid)}[${propsOf(c)}]`);
      inventory.push(`${shortUuid(s.uuid)}{${charIds.join(' ')}}`);
      this.log(`  service ${s.uuid} (${chars.length} characteristic(s))`);
      for (const c of chars) {
        this.log(`    char ${c.uuid} [${propsOf(c)}]`);
      }

      if (shortUuid(s.uuid) === '180f') {
        const b = chars.find((c) => shortUuid(c.uuid) === '2a19');
        if (b) batteryChar = b;
      }

      // GAIA data endpoints under the classic UUIDs...
      for (const uuid of [GAIA_DATA_V3_V2, GAIA_DATA_V1]) {
        const found = chars.find((c) => c.uuid.toLowerCase().includes(uuid));
        if (found) {
          candidates.push({ service: s, char: found, label: `${shortUuid(s.uuid)}/${shortUuid(found.uuid)}` });
        }
      }
    }

    // ...plus Sennheiser's proprietary companion service (fcfe, 6333xxxx
    // characteristics) seen on MOMENTUM 4. Not GAIA's f6cd/f6ce, but it is the
    // only vendor-specific BLE surface the device exposes, so probe it.
    for (const s of services) {
      if (shortUuid(s.uuid) !== 'fcfe') continue;
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        chars = await s.getCharacteristics();
      } catch {
        continue;
      }
      for (const c of chars) {
        const p = propsOf(c);
        if (p.includes('write') || p.includes('notify') || p.includes('indicate')) {
          candidates.push({ service: s, char: c, label: `${shortUuid(s.uuid)}/${shortUuid(c.uuid)}` });
        }
      }
    }

    if (candidates.length === 0) {
      this.log('!! no candidate data endpoints in any visible service');
      const inv = inventory.join('  ');
      throw new Error(
        services.length === 0
          ? 'The browser can see no BLE services on these headphones. Either they only expose their control service over Bluetooth Classic (unreachable from any browser), or the service UUID is not yet whitelisted in this app — open the Protocol console and file the log as an issue so support can be added.'
          : `No candidate data endpoints in the visible services. Inventory: ${inv}. This model likely exposes its control service only over Bluetooth Classic, which browsers cannot reach.`,
      );
    }

    this.log(`probing ${candidates.length} candidate endpoint(s): ${candidates.map((c) => c.label).join(', ')}`);
    const probed = await this.probeEndpoints(candidates);
    if (!probed) {
      this.log('!! no candidate endpoint answered the GAIA battery query');
      throw new Error(
        `Connected, but none of the candidate endpoints (${candidates.map((c) => c.label).join(', ')}) answered a GAIA command. ` +
          'This confirms the control channel on this device runs over Bluetooth Classic only — unreachable from any browser. ' +
          'Standard battery remains readable over BLE (see Device card).',
      );
    }
    this.characteristic = probed.char;
    this.framing = probed.framing;
    this.log(`using endpoint ${shortUuid(probed.char.uuid)} with ${probed.framing} framing`);

    // Battery service works regardless of the control channel.
    if (batteryChar) {
      try {
        const v = await batteryChar.readValue();
        if (v.byteLength >= 1) {
          this.log(`BLE battery service reports ${v.getUint8(0)}%`);
        }
      } catch {
        this.log('battery service read failed (may need pairing consent)');
      }
    }

    this.log('subscribing to notifications...');
    this.notificationHandler = (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristic;
      const value = target.value;
      if (!value) return;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      this.ingest(bytes);
    };
    await this.characteristic.startNotifications();
    this.characteristic.addEventListener('characteristicvaluechanged', this.notificationHandler);

    this.log(`connected. endpoint=${shortUuid(this.characteristic.uuid)} framing=${this.framing}`);
    return device.name ?? device.id;
  }

  onDisconnected: (() => void) | null = null;

  disconnect(): void {
    if (this.transport) {
      this.transportOpen = false;
      const session = this.transport;
      this.transport = null;
      session.close();
      this.cleanupAfterDisconnect();
      return;
    }
    this.device?.gatt?.disconnect();
    this.cleanupAfterDisconnect();
  }

  private cleanupAfterDisconnect(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('device disconnected'));
      this.pending = null;
    }
    this.characteristic = null;
  }

  /**
   * Send a command and await its GAIA response packet. Serialized.
   * Rejects on GAIA error responses and on timeout.
   */
  exchange(command: number, payload: Uint8Array = new Uint8Array(0), timeoutMs = 4000): Promise<GaiaPacket> {
    const run = () => this.exchangeInner(command, payload, timeoutMs);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    if (this.transport) {
      if (!this.transportOpen) throw new Error('not connected');
      await this.transport.write(bytes);
      return;
    }
    if (!this.characteristic) throw new Error('not connected');
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const withResponse = this.characteristic.writeValueWithResponse;
    if (withResponse) {
      await withResponse.call(this.characteristic, copy.buffer);
    } else {
      await this.characteristic.writeValue(copy.buffer);
    }
  }

  /** Write raw bytes on the active transport (no request/response framing). */
  async writeRaw(bytes: Uint8Array): Promise<void> {
    await this.writeBytes(bytes);
  }

  private async exchangeInner(command: number, payload: Uint8Array, timeoutMs: number): Promise<GaiaPacket> {
    if (!this.connected || (!this.transport && !this.characteristic)) throw new Error('not connected');

    const packet: GaiaPacket = { vendorId: VENDOR_ID, command, payload };
    const framed = framePacket(packet, this.framing, this.sequence++ & 0xff);
    this.log(`TX ${hex(framed.bytes)}`);

    const expected = responseFor(command);
    const promise = new Promise<GaiaPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.command === expected) {
          this.pending = null;
          reject(new Error(`timeout waiting for response 0x${expected.toString(16).padStart(4, '0')}`));
        }
      }, timeoutMs);
      this.pending = { command: expected, resolve, reject, timer };
    });

    await this.writeBytes(framed.bytes);

    return promise;
  }

  /** Fire a notification-registration style command without awaiting a response id. */
  async writeOnly(command: number, payload: Uint8Array = new Uint8Array(0)): Promise<void> {
    if (!this.transport && !this.characteristic) throw new Error('not connected');
    const packet: GaiaPacket = { vendorId: VENDOR_ID, command, payload };
    const framed = framePacket(packet, this.framing, this.sequence++ & 0xff);
    this.log(`TX ${hex(framed.bytes)}`);
    await this.writeBytes(framed.bytes);
  }

  private ingest(bytes: Uint8Array): void {
    this.log(`RX ${hex(bytes)}`);
    const { packets, notes } = decodeStream(bytes, this.decodeState);
    for (const note of notes) this.log(`   (decode) ${note}`);
    for (const packet of packets) {
      if (packet.vendorId !== VENDOR_ID) {
        this.log(`   packet with unexpected vendor 0x${packet.vendorId.toString(16).padStart(4, '0')} ignored`);
        continue;
      }
      const type = packetType(packet.command);
      this.log(`   GAIA ${type} 0x${packet.command.toString(16).padStart(4, '0')} payload=${hex(packet.payload)}`);

      if (type === 'response' || type === 'error') {
        const pending = this.pending;
        // pending.command holds the expected RESPONSE id; an error arrives as
        // response|0x0080, so mask the status bit before comparing.
        const wireId = packet.command & ~0x0080 & 0xffff;
        if (pending && pending.command === wireId) {
          clearTimeout(pending.timer);
          this.pending = null;
          if (isErrorResponse(packet.command)) {
            pending.reject(new Error(`device rejected command (GAIA error status ${packet.payload[0] ?? '?'})`));
          } else {
            pending.resolve(packet);
          }
        }
      }
      this.onNotification?.(packet);
    }
  }

  onNotification: ((packet: GaiaPacket) => void) | null = null;

  /**
   * Probe candidate endpoints until one answers a GAIA battery query.
   * For each endpoint: subscribe if notify/indicate capable, then send the
   * battery query under each framing. A valid 0x0703 response settles both
   * the endpoint and the wire framing in one step.
   */
  private async probeEndpoints(
    candidates: Array<{ service: BluetoothRemoteGATTService; char: BluetoothRemoteGATTCharacteristic; label: string }>,
  ): Promise<{ char: BluetoothRemoteGATTCharacteristic; framing: Framing } | null> {
    const probePayload = new Uint8Array(0);

    for (const candidate of candidates) {
      const p = propsOf(candidate.char);
      this.log(`-- probing ${candidate.label} [${p}]`);

      // Subscribe first when possible so the response can arrive as a notification.
      let handler: ((event: Event) => void) | null = null;
      if (p.includes('notify') || p.includes('indicate')) {
        handler = (event: Event) => {
          const target = event.target as BluetoothRemoteGATTCharacteristic;
          const value = target.value;
          if (!value) return;
          const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          this.ingest(bytes);
        };
        try {
          await candidate.char.startNotifications();
          candidate.char.addEventListener('characteristicvaluechanged', handler);
          this.log(`   subscribed to notifications on ${candidate.label}`);
        } catch (e) {
          this.log(`   subscribe failed: ${(e as Error).message}`);
        }
      }

      for (const framing of ['gatt-v3', 'spp-style'] as Framing[]) {
        this.framing = framing;
        this.decodeState = newDecodeState();
        try {
          const framed = framePacket({ vendorId: VENDOR_ID, command: 0x0603, payload: probePayload }, framing, this.sequence++ & 0xff);
          this.log(`   probe TX (${framing}) ${hex(framed.bytes)}`);
          const response = await this.exchangeOn(candidate.char, 0x0603, probePayload, 2000);
          this.log(`   -> answered with 0x${response.command.toString(16).padStart(4, '0')}`);
          if (handler) {
            candidate.char.removeEventListener('characteristicvaluechanged', handler);
          }
          try {
            await candidate.char.stopNotifications();
          } catch {
            /* keep going */
          }
          return { char: candidate.char, framing };
        } catch (e) {
          this.log(`   no answer (${framing}): ${(e as Error).message}`);
        }
      }

      if (handler) {
        candidate.char.removeEventListener('characteristicvaluechanged', handler);
        try {
          await candidate.char.stopNotifications();
        } catch {
          /* keep going */
        }
      }
    }
    return null;
  }

  /** Like exchange(), but pinned to a specific characteristic (probe phase). */
  private exchangeOn(char: BluetoothRemoteGATTCharacteristic, command: number, payload: Uint8Array, timeoutMs: number): Promise<GaiaPacket> {
    const expected = responseFor(command);
    // Held in a ref object so TS control-flow analysis doesn't narrow it to null.
    const rejectRef: { current: ((e: Error) => void) | null } = { current: null };
    const promise = new Promise<GaiaPacket>((resolve, reject) => {
      rejectRef.current = reject;
      const timer = setTimeout(() => {
        if (this.pending?.command === expected) {
          this.pending = null;
          reject(new Error(`timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending = { command: expected, resolve, reject, timer };
    });
    const packet: GaiaPacket = { vendorId: VENDOR_ID, command, payload };
    const framed = framePacket(packet, this.framing, this.sequence++ & 0xff);
    void (async () => {
      try {
        const copy = new Uint8Array(framed.bytes.length);
        copy.set(framed.bytes);
        const withResponse = char.writeValueWithResponse;
        if (withResponse) {
          await withResponse.call(char, copy.buffer);
        } else {
          await char.writeValue(copy.buffer);
        }
      } catch (e) {
        if (this.pending?.command === expected) {
          clearTimeout(this.pending.timer);
          this.pending = null;
          rejectRef.current?.(e as Error);
        }
      }
    })();
    return promise;
  }
}

function hex16(v: number): string {
  return `0000${v.toString(16)}`.slice(-4);
}

/** Compact UUID for inventory lines: 0000fcd7-0000-1000-8000-00805f9b34fb -> fcd7. */
function shortUuid(uuid: string): string {
  const m = /([0-9a-fA-F]{4})-0000-1000-8000-00805f9b34fb/.exec(uuid);
  return m ? m[1] : uuid.length > 8 ? uuid.slice(0, 8) : uuid;
}

/**
 * List a characteristic's properties. Chrome's BluetoothCharacteristicProperties
 * keeps its flags on the prototype, so Object.keys() returns [] — enumerate
 * the known property names explicitly instead.
 */
function propsOf(c: BluetoothRemoteGATTCharacteristic): string {
  const p = c.properties as unknown as Record<string, boolean> | undefined;
  if (!p) return '?';
  const names = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'];
  return names.filter((n) => p[n] === true).join('|') || 'none';
}

export { decodePacket };
