const DOWNLOAD_URL =
  'https://github.com/stefanfmeyer/smart-connect-bt-audio/releases/latest/download/Smart.Connect_x64-setup.exe';
const RELEASES_URL = 'https://github.com/stefanfmeyer/smart-connect-bt-audio/releases';
const REPO_URL = 'https://github.com/stefanfmeyer/smart-connect-bt-audio';

const FEATURES = [
  {
    title: 'Noise control',
    body: 'Off, Noise Cancelling, Adaptive and Transparency — with a transparency level slider from full ANC to full awareness, exactly like the official app.',
  },
  {
    title: 'Equalizer & bass boost',
    body: 'The editor reads band count and gain range from your headphones and adapts to them. Flat-line everything with one click, or push the low end with bass boost.',
  },
  {
    title: 'Sound modes',
    body: 'Equalizer, Podcast and Sound Personalization modes, switching directly on the headphones — including the guards the device itself enforces.',
  },
  {
    title: 'Battery',
    body: 'Live battery read-back after every change, with a clear charge bar — no guessing when to dock them.',
  },
  {
    title: 'Protocol console',
    body: 'Every GAIA frame in and out, byte for byte. Built for debugging, transparency and extending support to more headphone models.',
  },
  {
    title: 'Private by design',
    body: 'A direct Bluetooth connection from your PC to your headphones. No account, no cloud, no telemetry — nothing leaves your machine.',
  },
];

export default function Home() {
  return (
    <div className="app-root">
      <header className="app-header">
        <div className="app-logo">Smart Connect</div>
        <div className="app-header-right">
          <a className="btn" href="/app">
            Open web app
          </a>
          <a className="btn btn-primary" href={DOWNLOAD_URL}>
            Download for Windows
          </a>
        </div>
      </header>

      <main className="app-main">
        <section className="hero">
          <div className="hint">Unofficial · open source · MIT license · no account, no cloud</div>
          <h1>
            Your headphones.
            <br />
            Fully under your control.
          </h1>
          <p>
            A free desktop app for Windows and Linux that drives your headphones over their native GAIA control
            channel: noise cancelling, equalizer, sound modes and battery — all local, all direct Bluetooth.
            Built and verified on the Sennheiser MOMENTUM 4 Wireless; other GAIA-speaking models work too.
          </p>
          <div className="hero-meta">
            <a className="btn btn-primary" href={DOWNLOAD_URL}>
              Download for Windows
            </a>
            <a className="btn" href={RELEASES_URL}>
              All releases &amp; Linux packages
            </a>
          </div>
          <div className="hint">
            Windows 10/11 · x64 installer · unsigned binary, so Windows SmartScreen asks for “More info” → “Run
            anyway” on first run.
          </div>
        </section>

        <section className="grid-2">
          {FEATURES.map((f) => (
            <div className="card" key={f.title}>
              <div className="card-title">{f.title}</div>
              <div className="hint">{f.body}</div>
            </div>
          ))}
        </section>

        <section className="card">
          <div className="card-title">Why a desktop app?</div>
          <div className="hint">
            Browsers only expose Bluetooth LE, and the MOMENTUM 4 control channel runs over Bluetooth Classic
            RFCOMM — unreachable from any browser. The Tauri desktop app in this project speaks that channel
            natively, the same one the official vendor app uses. Close the official Sennheiser app before
            connecting: both fight over the same control socket.
          </div>
          <div className="hint">
            A limited <a href="/app">web app</a> (battery status, plus full control for models that expose GAIA
            over BLE) is included in the same project. The source lives on{' '}
            <a href={REPO_URL}>GitHub</a>, and every release ships with SHA-256 checksums.
          </div>
        </section>
      </main>

      <footer className="app-footer">
        Unofficial, independent project. Not affiliated with, authorized by, endorsed by, or supported by
        Sennheiser or Sonova. Sennheiser and MOMENTUM are trademarks of their respective owners.
      </footer>
    </div>
  );
}
