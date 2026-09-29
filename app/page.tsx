'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { currentNoiseMode, NoiseMode, ProtocolLine, useHeadphones } from '@/lib/ble/use-headphones';
import { HeadphoneProfile, loadProfiles, profileFromSnapshot, saveProfiles } from '@/lib/profiles';
import { SOUND_MODE, SOUND_MODE_NAMES } from '@/lib/ble/sennheiser';

const NOISE_MODES: Array<{ id: NoiseMode; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'anc', label: 'Noise Cancelling' },
  { id: 'adaptive', label: 'Adaptive' },
  { id: 'transparency', label: 'Transparency' },
];

// Common frequency labels for typical Sennheiser 5-band EQ; the device reports
// band count and gain range, not center frequencies.
const BAND_LABELS = ['100 Hz', '315 Hz', '1 kHz', '3.15 kHz', '8 kHz', '12 kHz', '16 kHz', '20 kHz'];

export default function Home() {
  const hp = useHeadphones();
  const [profiles, setProfiles] = useState<HeadphoneProfile[]>([]);
  const [profileName, setProfileName] = useState('');
  const [showConsole, setShowConsole] = useState(false);
  const [localLevel, setLocalLevel] = useState<number | null>(null);
  const [localEq, setLocalEq] = useState<number[] | null>(null);
  const [mounted, setMounted] = useState(false);
  const levelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eqTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMounted(true);
    setProfiles(loadProfiles());
  }, []);

  useEffect(() => {
    if (showConsole && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [showConsole, hp.protocol]);

  const eqBands = localEq ?? hp.snapshot.eqBands;
  const transparencyLevel = localLevel ?? hp.snapshot.transparencyLevel ?? 100;
  const mode = hp.mode;

  // Browser-capability dependent UI must only render after hydration.
  // navigator.bluetooth differs between server (absent) and Chrome (present),
  // which would otherwise trip React hydration error #418.
  const webBluetoothSupported = mounted && hp.webBluetoothSupported;

  const eqSummary = useMemo(() => {
    if (!eqBands) return '';
    return eqBands.map((g) => `${g > 0 ? '+' : ''}${g.toFixed(1)}`).join(' ');
  }, [eqBands]);

  function persistProfiles(next: HeadphoneProfile[]) {
    setProfiles(next);
    saveProfiles(next);
  }

  async function handleConnect() {
    await hp.connect();
  }

  async function handleNoiseMode(next: NoiseMode) {
    try {
      await hp.setNoiseMode(next, transparencyLevel);
    } catch {
      /* error already surfaced via hp.error */
    }
  }

  function onLevelChange(value: number) {
    setLocalLevel(value);
    if (levelTimer.current) clearTimeout(levelTimer.current);
    levelTimer.current = setTimeout(() => {
      hp.setTransparencyLevel(value).catch(() => undefined);
      setLocalLevel(null);
    }, 350);
  }

  function onEqChange(band: number, gain: number) {
    if (!eqBands) return;
    const next = [...eqBands];
    next[band] = gain;
    setLocalEq(next);
    if (eqTimer.current) clearTimeout(eqTimer.current);
    eqTimer.current = setTimeout(() => {
      hp.setEqBand(band, gain).catch(() => undefined);
      setLocalEq(null);
    }, 400);
  }

  function handleSaveProfile() {
    const name = profileName.trim() || `Profile ${profiles.length + 1}`;
    const profile = profileFromSnapshot(name, hp.snapshot, mode ?? 'anc');
    persistProfiles([...profiles, profile]);
    setProfileName('');
  }

  async function handleApplyProfile(p: HeadphoneProfile) {
    try {
      await hp.setNoiseMode(p.noiseMode, p.transparencyLevel);
      if (p.eqBands) await hp.setEqBands(p.eqBands);
      if (hp.snapshot.bassBoost !== null) await hp.setBassBoost(p.bassBoost);
      if (p.soundMode !== null) await hp.setSoundMode(p.soundMode);
    } catch {
      /* surfaced */
    }
  }

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="app-logo">Smart Connect for Sennheiser</div>
        <div className="app-header-right">
          <span className="connection-pill">
            <span className={`connection-dot ${hp.status === 'connected' ? 'on' : hp.status === 'connecting' ? 'wait' : ''}`} />
            {hp.status === 'connected' ? hp.deviceName : hp.status}
            {hp.framing ? ` · ${hp.framing}` : ''}
          </span>
          {hp.status === 'connected' ? (
            <button onClick={hp.disconnect}>Disconnect</button>
          ) : (
            <button className="btn-primary" onClick={handleConnect} disabled={hp.status === 'connecting' || !webBluetoothSupported}>
              Connect headphones
            </button>
          )}
        </div>
      </header>

      <main className="app-main">
        {!webBluetoothSupported && (
          <div className="banner">
            <span>
              This browser does not expose Web Bluetooth. Use Chrome, Edge or Opera on a desktop with Bluetooth, served over
              HTTPS or localhost.
            </span>
          </div>
        )}

        {hp.error && (
          <div className="banner">
            <span>{hp.error}</span>
            <button onClick={hp.clearError}>Dismiss</button>
          </div>
        )}

        {hp.status !== 'connected' ? (
          <section className="hero">
            <h1>Control your Sennheiser from the browser.</h1>
            <p>
              Noise control, equalizer and personal sound profiles over a direct Bluetooth connection to your PC &mdash; no
              account, no install, nothing leaves your machine. Headphones must already be paired with this computer in your
              operating system&rsquo;s Bluetooth settings.
            </p>
            <button className="btn-primary" style={{ alignSelf: 'flex-start' }} onClick={handleConnect} disabled={!webBluetoothSupported || hp.status === 'connecting'}>
              {hp.status === 'connecting' ? 'Connecting…' : 'Connect headphones'}
            </button>
            <div className="hint">
              Unofficial, independent tool for the Sennheiser range (MOMENTUM, ACCENTUM, CX and similar). Noise control and
              EQ are verified on hardware that exposes the GAIA control service over BLE; devices that only speak it over
              Bluetooth Classic cannot be reached from any browser &mdash; the app will tell you if that is the case.
            </div>
          </section>
        ) : (
          <>
            {/* Status */}
            <section className="grid-2">
              <div className="card">
                <div className="card-title">Device</div>
                <div className="card-row">
                  <div>
                    <div className="stat-value">{hp.snapshot.battery !== null ? `${hp.snapshot.battery}%` : '—'}</div>
                    <div className="stat-label">Battery</div>
                  </div>
                  <div>
                    <div className="stat-value">{mode ? labelForMode(mode) : '—'}</div>
                    <div className="stat-label">Noise control</div>
                  </div>
                  <button onClick={hp.refreshBattery} disabled={hp.busy}>
                    Refresh
                  </button>
                </div>
                <div className="battery-track">
                  <div className="battery-fill" style={{ width: `${hp.snapshot.battery ?? 0}%` }} />
                </div>
              </div>

              <div className="card">
                <div className="card-title">Sound mode</div>
                <div className="card-row" style={{ gap: 'var(--sp-2)' }}>
                  {Object.values(SOUND_MODE)
                    .filter((v) => v !== SOUND_MODE.off)
                    .map((m) => (
                      <button
                        key={m}
                        className={hp.snapshot.soundMode === m ? 'btn-primary' : undefined}
                        disabled={hp.busy}
                        onClick={() => hp.setSoundMode(m).catch(() => undefined)}
                      >
                        {SOUND_MODE_NAMES[m]}
                      </button>
                    ))}
                </div>
                <div className="hint">
                  Sound Personalization requires a calibrated profile on the headphones and Better Compatibility mode;
                  the device rejects the switch otherwise.
                </div>
              </div>
            </section>

            {/* Noise control */}
            <section className="card">
              <div className="card-row">
                <div className="card-title">Noise control</div>
                {hp.snapshot.ancModes && (
                  <div className="hint">
                    adaptive {hp.snapshot.ancModes.adaptiveEnabled ? 'on' : 'off'} · antiwind{' '}
                    {['off', 'max', 'auto'][hp.snapshot.ancModes.antiWind] ?? hp.snapshot.ancModes.antiWind} · comfort{' '}
                    {hp.snapshot.ancModes.comfortEnabled ? 'on' : 'off'}
                  </div>
                )}
              </div>
              <div className="segmented">
                {NOISE_MODES.map((m) => (
                  <button key={m.id} className={mode === m.id ? 'active' : undefined} disabled={hp.busy} onClick={() => handleNoiseMode(m.id)}>
                    {m.label}
                  </button>
                ))}
              </div>
              {mode === 'transparency' && (
                <div className="level-row">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={transparencyLevel}
                    disabled={hp.busy}
                    onChange={(e) => onLevelChange(Number(e.target.value))}
                  />
                  <span className="level-value">{transparencyLevel}%</span>
                </div>
              )}
            </section>

            {/* Equalizer */}
            <section className="card">
              <div className="card-row">
                <div className="card-title">Equalizer</div>
                {hp.snapshot.eqConfig ? (
                  <div className="hint">
                    {hp.snapshot.eqConfig.bandCount} bands · {hp.snapshot.eqConfig.minGainDb} to +{hp.snapshot.eqConfig.maxGainDb} dB
                  </div>
                ) : (
                  <div className="hint">EQ config not read yet</div>
                )}
              </div>
              {eqBands && hp.snapshot.eqConfig ? (
                <>
                  <div className="eq-grid">
                    {eqBands.map((gain, band) => (
                      <div className="eq-band" key={band}>
                        <span className="eq-gain">
                          {gain > 0 ? '+' : ''}
                          {gain.toFixed(1)}
                        </span>
                        <input
                          type="range"
                          min={hp.snapshot.eqConfig!.minGainDb * 10}
                          max={hp.snapshot.eqConfig!.maxGainDb * 10}
                          step={1}
                          value={Math.round(gain * 10)}
                          disabled={hp.busy}
                          onChange={(e) => onEqChange(band, Number(e.target.value) / 10)}
                        />
                        <span className="eq-freq">{BAND_LABELS[band] ?? `Band ${band + 1}`}</span>
                      </div>
                    ))}
                  </div>
                  <div className="card-row">
                    <div className="hint">mono {eqSummary}</div>
                    <button
                      disabled={hp.busy}
                      onClick={() => {
                        if (!eqBands) return;
                        hp.setEqBands(eqBands.map(() => 0)).catch(() => undefined);
                      }}
                    >
                      Flatten
                    </button>
                  </div>
                </>
              ) : (
                <div className="hint">Connect to a device that exposes the EQ service to edit bands.</div>
              )}
              <div className="toggle-row">
                <div>
                  <div className="toggle-label">Bass boost</div>
                  <div className="toggle-sub">device-side bass enhancement</div>
                </div>
                <button
                  aria-pressed={!!hp.snapshot.bassBoost}
                  className={`switch ${hp.snapshot.bassBoost ? 'on' : ''}`}
                  disabled={hp.busy || hp.snapshot.bassBoost === null}
                  onClick={() => hp.setBassBoost(!hp.snapshot.bassBoost).catch(() => undefined)}
                />
              </div>
            </section>

            {/* Profiles */}
            <section className="card">
              <div className="card-title">Profiles</div>
              <div className="card-row">
                <input
                  className="input"
                  style={{ flex: 1 }}
                  placeholder="Profile name"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                />
                <button onClick={handleSaveProfile} disabled={hp.busy}>
                  Save current settings
                </button>
              </div>
              {profiles.length === 0 ? (
                <div className="hint">No profiles yet. Tune the headphones, then save the settings here.</div>
              ) : (
                <div className="profile-list">
                  {profiles.map((p) => (
                    <div className="profile-item" key={p.id}>
                      <div>
                        <div className="profile-name">{p.name}</div>
                        <div className="profile-summary">
                          {labelForMode(p.noiseMode)}
                          {p.noiseMode === 'transparency' ? ` ${p.transparencyLevel}%` : ''} · EQ{' '}
                          {p.eqBands ? p.eqBands.map((g) => `${g > 0 ? '+' : ''}${g.toFixed(1)}`).join('/') : '—'} · bass{' '}
                          {p.bassBoost ? 'on' : 'off'}
                        </div>
                      </div>
                      <div className="profile-actions">
                        <button className="btn-primary" disabled={hp.busy} onClick={() => handleApplyProfile(p)}>
                          Apply
                        </button>
                        <button onClick={() => persistProfiles(profiles.filter((x) => x.id !== p.id))}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="hint">
                Profiles live in this browser&rsquo;s local storage on this machine. They are never uploaded anywhere.
              </div>
            </section>

            {/* Protocol console */}
            <section className="card">
              <div className="card-row">
                <div className="card-title">Protocol console</div>
                <button onClick={() => setShowConsole((v) => !v)}>{showConsole ? 'Hide' : 'Show'}</button>
              </div>
              {showConsole && <Console lines={hp.protocol} ref={consoleRef} />}
              <div className="hint">
                Every GAIA frame in and out, byte for byte. If your model is not yet supported, paste this log into an issue.
              </div>
            </section>
          </>
        )}
      </main>

      <footer className="app-footer">
        Unofficial, independent project. Not affiliated with, authorized by, endorsed by, or supported by Sennheiser or
        Sonova. Sennheiser and MOMENTUM are trademarks of their respective owners.
      </footer>
    </div>
  );
}

function labelForMode(mode: NoiseMode): string {
  return NOISE_MODES.find((m) => m.id === mode)?.label ?? mode;
}

function Console({ lines, ref }: { lines: ProtocolLine[]; ref: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div className="console" ref={ref}>
      {lines.length === 0 ? <div className="console-line info">no traffic yet</div> : null}
      {lines.map((line, i) => (
        <div className={`console-line ${line.dir}`} key={`${line.t}-${i}`}>
          <span className="dir">{line.dir === 'tx' ? '→' : line.dir === 'rx' ? '←' : line.dir === 'err' ? '!' : '·'} </span>
          {line.text}
        </div>
      ))}
    </div>
  );
}
