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

  constructor(private log: LogSink) {}

  get connected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  get deviceName(): string {
    return this.device?.name ?? 'headphones';
  }

  get activeFraming(): Framing {
    return this.framing;
  }

  async connect(): Promise<string> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available. Use Chrome/Edge on desktop over HTTPS or localhost.');
    }

    this.log('requesting device (filters: Sennheiser name prefixes, GAIA service)...');
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [GAIA_SERVICE_UUID] },
          { namePrefix: 'Sennheiser' },
          { namePrefix: 'MOMENTUM' },
          { namePrefix: 'CX' },
          { namePrefix: 'HD ' },
          { namePrefix: 'ACCENTUM' },
        ],
        optionalServices: [...KNOWN_SERVICE_UUIDS],
      });
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
    let service: BluetoothRemoteGATTService | null = null;
    let dataChar: BluetoothRemoteGATTCharacteristic | null = null;

    for (const s of services) {
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        chars = await s.getCharacteristics();
      } catch {
        this.log(`  service ${s.uuid}: characteristics unreadable`);
        continue;
      }
      this.log(`  service ${s.uuid} (${chars.length} characteristic(s))`);
      for (const c of chars) {
        const props = Object.keys(c.properties ?? {})
          .filter((k) => (c.properties as Record<string, boolean>)[k])
          .join('|');
        this.log(`    char ${c.uuid} [${props}]`);
      }
      if (!dataChar) {
        for (const uuid of [GAIA_DATA_V3_V2, GAIA_DATA_V1]) {
          const found = chars.find((c) => c.uuid.toLowerCase().includes(uuid));
          if (found) {
            service = s;
            dataChar = found;
            this.log(`  -> GAIA data endpoint ${uuid} found in ${s.uuid}`);
            break;
          }
        }
      }
    }

    if (!service || !dataChar) {
      this.log('!! no GAIA data endpoint (f6cd/f6ce) in any visible service');
      throw new Error(
        services.length === 0
          ? 'The browser can see no BLE services on these headphones. Either they only expose their control service over Bluetooth Classic (unreachable from any browser), or the service UUID is not yet whitelisted in this app — open the Protocol console and file the log as an issue so support can be added.'
          : 'Found BLE services but no GAIA data endpoint (f6cd/f6ce) among them. This model likely exposes its control service only over Bluetooth Classic, which browsers cannot reach. Protocol console has the full service inventory.',
      );
    }
    this.characteristic = dataChar;

    this.log('subscribing to notifications...');
    this.notificationHandler = (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristic;
      const value = target.value;
      if (!value) return;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      this.ingest(bytes);
    };
    await dataChar.startNotifications();
    dataChar.addEventListener('characteristicvaluechanged', this.notificationHandler);

    this.log('probing framing with battery query...');
    const probe = await this.probeFraming();
    this.framing = probe;

    this.log(`connected. framing=${this.framing}`);
    return device.name ?? device.id;
  }

  onDisconnected: (() => void) | null = null;

  disconnect(): void {
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

  private async exchangeInner(command: number, payload: Uint8Array, timeoutMs: number): Promise<GaiaPacket> {
    if (!this.connected || !this.characteristic) throw new Error('not connected');

    const packet: GaiaPacket = { vendorId: VENDOR_ID, command, payload };
    const framed = framePacket(packet, this.framing, this.sequence++ & 0xff);
    this.log(`TX ${hex(framed.bytes)}`);

    const expected = responseFor(command);
    const promise = new Promise<GaiaPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.command === command) {
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
    if (!this.characteristic) throw new Error('not connected');
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
        if (pending && pending.command === packet.command) {
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
   * Probe: send the battery query under gatt-v3 framing; if no valid response
   * arrives, switch framing to spp-style and retry once.
   */
  private async probeFraming(): Promise<Framing> {
    const attempt = async (framing: Framing): Promise<GaiaPacket> => {
      this.framing = framing;
      const packet: GaiaPacket = { vendorId: VENDOR_ID, command: 0x0603, payload: new Uint8Array(0) };
      const framed = framePacket(packet, framing, this.sequence++ & 0xff);
      this.log(`probe TX (${framing}) ${hex(framed.bytes)}`);
      return this.exchange(0x0603, new Uint8Array(0), 2500);
    };
    try {
      await attempt('gatt-v3');
      return 'gatt-v3';
    } catch (e) {
      this.log(`gatt-v3 probe failed (${(e as Error).message}); retrying with spp-style framing`);
    }
    await attempt('spp-style');
    return 'spp-style';
  }
}

function hex16(v: number): string {
  return `0000${v.toString(16)}`.slice(-4);
}

export { decodePacket };
