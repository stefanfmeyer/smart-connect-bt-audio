# Smart Connect for Sennheiser

An unofficial, open-source **web app** that puts Sennheiser headphone controls in your browser:
noise cancelling modes, equalizer, bass boost, sound modes and personal profiles — over a direct
Bluetooth connection from your PC. No account, no install, no cloud: everything runs locally in
your browser.

Built with Next.js (App Router) + Web Bluetooth. UI uses the monochrome Longship theme.

## Features

- **Noise control** — Off / Noise Cancelling (manual) / Adaptive / Transparency, with a
  transparency level slider (0-100).
- **Equalizer** — band count and gain range are read from the headphones, so the editor adapts
  to the device; plus bass boost toggle.
- **Sound modes** — Equalizer / Podcast / Sound Personalization (the device rejects Sound
  Personalization unless a calibrated profile exists and Better Compatibility mode is active).
- **Battery** status with live read-back after every change.
- **Profiles** — save the current settings locally (noise mode, transparency level, EQ curve,
  bass boost, sound mode) and re-apply them to the headphones in one click. Profiles are stored
  in your browser's local storage and never leave your machine.
- **Protocol console** — every GAIA frame in and out, byte for byte, for debugging and for
  extending device support.

## Browser & hardware requirements

- **Chrome, Edge or Opera** on a desktop computer (Web Bluetooth). Firefox and Safari do not
  expose Web Bluetooth. The page must be served over **HTTPS or localhost**.
- Headphones must already be **paired with the computer** in the OS Bluetooth settings.
- The app talks to the headphones' **GAIA control service over BLE GATT** (Web Bluetooth cannot
  reach Bluetooth Classic RFCOMM, which some Sennheiser models/official apps use for control).
  Devices that expose the control service only over Classic cannot be controlled from any
  browser; the app reports this instead of pretending to work. Confirmed-reachable models today:
  MOMENTUM 4 Wireless. Other Sennheiser models are matched by name and may work — check the
  protocol console and open an issue with the log.

## Run it

```bash
npm install
npm run dev
# open http://localhost:3000 in Chrome/Edge, click "Connect headphones"
```

Production:

```bash
npm run build
npm start
```

Protocol logic checks (no hardware needed):

```bash
npx tsx scripts/verify-protocol.ts
```

## Protocol notes

The control surface is the Qualcomm **GAIA** protocol with Sennheiser vendor id `0x0495`.
Command IDs, payload layouts and sequences were verified against two independent MIT-licensed
reverse-engineering projects (m4-companion, OpenMomentum); see `lib/ble/sennheiser.ts` for the
full annotated command table. Key commands:

| Function | Request | Response | Payload |
| --- | --- | --- | --- |
| Battery | `0x0603` | `0x0703` | percentage 0-100 |
| ANC enable/disable | `0x1a04` / `0x1a05` | `0x1b04` / `0x1b05` | bool |
| ANC sub-modes | `0x1a00` / `0x1a01` | `0x1b00` / `0x1b01` | `[mode, state]` pairs; adaptive = `03` |
| Transparency level | `0x1a02` / `0x1a03` | `0x1b02` / `0x1b03` | 0-100 |
| Transparent hearing | `0x1804` / `0x1805` | `0x1904` / `0x1905` | bool |
| EQ config | `0x1000` | `0x1100` | `[bandCount, minGain(s8 tenths dB), maxGain]` |
| EQ band get/set | `0x1002` / `0x1001` | `0x1102` / `0x1101` | `[band, gain(s8 tenths dB)]` |
| Bass boost | `0x1009` / `0x1008` | `0x1109` / `0x1108` | bool |
| Sound mode | `0x0804` / `0x0803` | `0x0904` / `0x0903` | 0 off / 1 EQ / 2 podcast / 3 sound personalization |

Safety rules followed from the reference implementations: no unknown or destructive commands,
bounded response waits, one outstanding command at a time, vendor/response-id/payload validation,
and a fresh state read-back after every write sequence. Firmware updating is intentionally out of
scope.

## Trademark and warranty

This app is independent and is not affiliated with, authorized by, endorsed by, or supported by Sennheiser or Sonova. Sennheiser and MOMENTUM are trademarks of their respective owners and are used only to identify compatible hardware.

The software is provided without warranty under the MIT License.
