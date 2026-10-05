# Smart Connect for Sennheiser

An unofficial, open-source **Windows desktop app** that controls Sennheiser headphones directly
over Bluetooth: noise cancelling modes, equalizer, bass boost, sound modes and battery.
No account, no cloud — everything runs locally on your machine, speaking the same
**GAIA** control protocol (Bluetooth Classic RFCOMM) the official vendor app uses.

Built with Next.js + TypeScript in a Tauri shell (Rust/WinRT transport). UI uses the monochrome
Longship theme. Primary/verified hardware: **MOMENTUM 4 Wireless**.

## Features

- **Noise control** — Off / Noise Cancelling (manual) / Adaptive / Transparency, with a
  transparency level slider (0-100).
- **Equalizer** — band count and gain range are read from the headphones, so the editor adapts
  to the device; plus bass boost toggle.
- **Sound modes** — Equalizer / Podcast / Sound Personalization (the device rejects Sound
  Personalization unless a calibrated profile exists and Better Compatibility mode is active).
- **Battery** status with live read-back after every change.
- **Protocol console** — every GAIA frame in and out, byte for byte, for debugging and for
  extending device support.

## Download & install (Windows x64)

1. Grab the latest installer from **[Releases](https://github.com/stefanfmeyer/smart-connect-bt-audio/releases/latest)**
   — `Smart Connect_<version>_x64-setup.exe` (NSIS). A `.msi` is also attached, and every
   release includes SHA-256 checksums in the notes. Permanent "latest" link (always the newest
   installer, no matter the version):
   [Download Smart Connect for Windows](https://github.com/stefanfmeyer/smart-connect-bt-audio/releases/latest/download/Smart.Connect_x64-setup.exe).
2. Run the installer. Windows SmartScreen may warn about an unsigned binary —
   *More info* → *Run anyway*.
3. Pair your headphones in **Windows Bluetooth settings** (if not already done).
4. **Close the official Sennheiser Smart Control app before connecting** — both apps fight
   over the same RFCOMM control socket, and only one can win.
5. Keep the headphones **out of the case**, launch Smart Connect and click **Connect**.
6. On first connection Windows shows a consent prompt for the RFCOMM service — accept it.

Older versions stay available on the
[releases page](https://github.com/stefanfmeyer/smart-connect-bt-audio/releases).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Device not listed | Pair in Windows Bluetooth settings first; the app only sees paired devices. |
| Connect fails / times out | Close the official Sennheiser app (socket conflict), headphones out of the case, then retry. |
| Windows consent prompt blocked/denied | Re-connect; accept the RFCOMM service prompt. |
| Commands do nothing | Check the protocol console for `ERR` responses and open an issue with the log. |
| Two-way audio stops | The control channel is separate from audio; toggle the headphones' own power button. |

The headphones' firmware is never touched — firmware updating is intentionally out of scope.

## Versioning & updates

Versions live in three places (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`)
and are kept in sync by the bump script:

```bash
node scripts/bump-version.mjs --patch   # or --minor / --major / 0.2.0
git commit -am "Bump version to X.Y.Z"
git tag vX.Y.Z && git push origin main vX.Y.Z
```

Pushing a `vX.Y.Z` tag triggers the **Release desktop app** workflow: it verifies the tag matches
the app version, builds the Windows installers, and publishes a GitHub Release with the `.exe`,
`.msi` and SHA-256 checksums attached. Every regular push to `main` additionally builds the
installers as a CI artifact (`smart-connect-windows-x64`) without publishing a release.

## Build from source

Requirements: Node 22+, Rust (stable) + the `x86_64-pc-windows-msvc` target on Windows.

```bash
npm install
npx tauri dev      # run the desktop app with hot reload
npx tauri build    # produce installers in src-tauri/target/release/bundle/
```

Protocol logic checks (no hardware needed):

```bash
npx tsx scripts/verify-protocol.ts
```

CI (`.github/workflows/`) builds the Tauri app on GitHub's Windows runners: `desktop.yml` on
every push to `main` (artifact `smart-connect-windows-x64`), `release.yml` on `v*` tags
(published release with installers).

## Web app (secondary)

A browser-only variant lives in the same repo and is deployed at
**https://smart-connect-bt-audio.vercel.app/** — the root is a marketing/download page, the
control UI lives at [/app](https://smart-connect-bt-audio.vercel.app/app). Browsers only expose
BLE GATT (Web Bluetooth),
and the MOMENTUM 4 control channel (verified by hardware probe against the `fcfe` companion
service) runs over Bluetooth Classic RFCOMM only — so the web app cannot fully control the M4.
It remains useful for models that expose GAIA over BLE (matched by name) and for battery reads.

Run it locally:

```bash
npm run dev     # http://localhost:3000 in Chrome/Edge/Opera (Web Bluetooth + HTTPS or localhost)
npm run build && npm start   # production
```

Web requirements: Chrome, Edge or Opera on desktop (Firefox/Safari do not expose Web
Bluetooth), headphones paired with the computer.

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
and a fresh state read-back after every write sequence.

## Trademark and warranty

This app is independent and is not affiliated with, authorized by, endorsed by, or supported by Sennheiser or Sonova. Sennheiser and MOMENTUM are trademarks of their respective owners and are used only to identify compatible hardware.

The software is provided without warranty under the MIT License.
