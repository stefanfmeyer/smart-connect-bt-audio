#!/usr/bin/env node
/**
 * Bump the app version across package.json, src-tauri/tauri.conf.json and
 * src-tauri/Cargo.toml(+Cargo.lock) so installers, releases and the UI stay in sync.
 *
 * Usage:
 *   node scripts/bump-version.mjs 0.2.0        # set an explicit version
 *   node scripts/bump-version.mjs --patch      # 0.1.0 -> 0.1.1
 *   node scripts/bump-version.mjs --minor      # 0.1.0 -> 0.2.0
 *   node scripts/bump-version.mjs --major      # 0.1.0 -> 1.0.0
 *
 * Run from the repo root. After it finishes, commit all changed files together,
 * then tag:  git tag vX.Y.Z && git push origin main vX.Y.Z
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+$/;

// --- figure out the target version -----------------------------------------
const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/bump-version.mjs <X.Y.Z | --patch | --minor | --major>");
  process.exit(1);
}

function readVersion(file) {
  const pkg = JSON.parse(readFileSync(join(root, file), "utf8"));
  if (SEMVER.test(pkg.version)) return pkg.version;
  throw new Error(`${file}: missing or invalid "version" field`);
}

const current = readVersion("package.json");

for (const f of ["src-tauri/tauri.conf.json"]) {
  const v = readVersion(f);
  if (v !== current) {
    throw new Error(`Version mismatch: package.json=${current} ${f}=${v}. Fix manually first.`);
  }
}

const cargoText = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
const cargoMatch = cargoText.match(/^version\s*=\s*"([^"]+)"/m);
if (!cargoMatch) throw new Error("src-tauri/Cargo.toml: no [package] version found");
if (cargoMatch[1] !== current) {
  throw new Error(
    `Version mismatch: package.json=${current} src-tauri/Cargo.toml=${cargoMatch[1]}. Fix manually first.`
  );
}

let target;
if (arg === "--patch" || arg === "--minor" || arg === "--major") {
  const [maj, min, pat] = current.split(".").map(Number);
  target =
    arg === "--major"
      ? `${maj + 1}.0.0`
      : arg === "--minor"
        ? `${maj}.${min + 1}.0`
        : `${maj}.${min}.${pat + 1}`;
} else {
  if (!SEMVER.test(arg)) {
    console.error(`Invalid version "${arg}" — expected X.Y.Z (semver, no "v" prefix).`);
    process.exit(1);
  }
  target = arg;
}

if (target === current) {
  console.log(`Already at version ${current} — nothing to do.`);
  process.exit(0);
}

// --- apply ------------------------------------------------------------------
function updateJson(file, transform) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const updated = transform(text, target);
  writeFileSync(path, updated);
  console.log(`  ${file}: ${current} -> ${target}`);
}

updateJson("package.json", (t, v) => t.replace(/("version"\s*:\s*")[^"]+(")/, `$1${v}$2`));
updateJson("src-tauri/tauri.conf.json", (t, v) => t.replace(/("version"\s*:\s*")[^"]+(")/, `$1${v}$2`));

{
  const updated = cargoText.replace(
    /^(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
    `$1${target}$2`
  );
  writeFileSync(join(root, "src-tauri/Cargo.toml"), updated);
  console.log(`  src-tauri/Cargo.toml: ${current} -> ${target}`);
}

// Keep Cargo.lock in sync so the release build doesn't dirty the tree.
const lockPath = join(root, "src-tauri/Cargo.lock");
if (existsSync(lockPath)) {
  try {
    execFileSync("cargo", ["update", "-p", "app", "--precise", target], {
      cwd: join(root, "src-tauri"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    console.log(`  src-tauri/Cargo.lock: app -> ${target}`);
  } catch {
    // cargo not installed or lock layout differs; release workflow regenerates it anyway.
    console.log("  (skipped Cargo.lock update — cargo unavailable; it syncs on next build)");
  }
}

console.log(`\nVersion bumped ${current} -> ${target}.`);
console.log("Next: commit, then  git tag v" + target + " && git push origin main --tags");
