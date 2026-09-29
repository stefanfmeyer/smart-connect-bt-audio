// Minimal Web Bluetooth API type declarations (subset used by this app).
// The standard TypeScript lib.dom does not include Web Bluetooth.

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly service: BluetoothRemoteGATTService;
  readonly uuid: string;
  readonly properties: Record<string, boolean>;
  readonly value?: DataView;
  readValue(): Promise<DataView>;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTService {
  readonly device: BluetoothDevice;
  readonly uuid: string;
  readonly isPrimary: boolean;
  getCharacteristic(uuid: string | number): Promise<BluetoothRemoteGATTCharacteristic>;
  getCharacteristics(uuid?: string | number): Promise<BluetoothRemoteGATTCharacteristic[]>;
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string | number): Promise<BluetoothRemoteGATTService>;
  getPrimaryServices(uuid?: string | number): Promise<BluetoothRemoteGATTService[]>;
}

interface BluetoothAdvertisingData {
  readonly rssi?: number;
  readonly txPower?: number;
  readonly uuids?: string[];
  readonly manufacturerData?: Map<number, DataView>;
}

interface BluetoothDevice extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
  readonly watchAdvertisements?: (options?: { signal?: AbortSignal }) => Promise<void>;
  forget?(): Promise<void>;
}

interface RequestDeviceOptions {
  filters?: Array<{
    services?: Array<string | number>;
    name?: string;
    namePrefix?: string;
  }>;
  optionalServices?: Array<string | number>;
  acceptAllDevices?: boolean;
}

interface Bluetooth {
  getAvailability?(): Promise<boolean>;
  requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>;
}

interface Navigator {
  readonly bluetooth?: Bluetooth;
}
