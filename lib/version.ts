import pkg from '../package.json';

/** App version, single source of truth: package.json (kept in sync with
 * tauri.conf.json / Cargo.toml by scripts/bump-version.mjs). */
export const APP_VERSION: string = pkg.version;
