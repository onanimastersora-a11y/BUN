// Self-update for the macOS app (used by updater.js). BUN isn't signed with an
// Apple Developer ID, so the standard updater refuses it. Instead the new BUN.app
// is downloaded, checked against its hash, and swapped in by a small script once
// BUN has exited. No Electron here, so this can be tested on its own.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// latest-mac.yml, written by electron-builder next to the zip.
export function parseUpdateInfo(yml) {
  const get = (key) => String(yml).match(new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm'))?.[1];
  return { version: get('version'), path: get('path'), sha512: get('sha512') };
}

export const appBundlePath = (exePath) => exePath.replace(/\/Contents\/MacOS\/[^/]+$/, '');

// Run from the disk image, or somewhere read-only: nothing can be replaced there.
export function canReplaceApp(appPath) {
  if (appPath.includes('/AppTranslocation/') || appPath.startsWith('/Volumes/')) return false;
  try {
    fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
    fs.accessSync(appPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function downloadVerified({ fetch, url, sha512, file, onProgress }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      if (total) onProgress?.(Math.round((got / total) * 100));
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  if (hash.digest('base64') !== sha512) {
    fs.rmSync(file, { force: true });
    throw new Error('update file is damaged');
  }
}

export function extractZip(zip, dest) {
  return new Promise((resolve, reject) => execFile('/usr/bin/ditto', ['-x', '-k', zip, dest], (err) => (err ? reject(err) : resolve())));
}

// Waits for BUN to exit, swaps the app (putting the old one back if that fails)
// and opens it again.
export const SWAP_SCRIPT = `#!/bin/sh
PID="$1"; APP="$2"; NEW="$3"; RELAUNCH="$4"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 150 ]; then exit 1; fi
  sleep 0.2
done
OLD="$APP.old-$$"
if mv "$APP" "$OLD"; then
  if mv "$NEW" "$APP"; then
    rm -rf "$OLD"
    xattr -cr "$APP" 2>/dev/null
  else
    mv "$OLD" "$APP"
  fi
fi
if [ "$RELAUNCH" = "1" ]; then open "$APP"; fi
`;

export function startSwap({ pid, appPath, newApp, relaunch, scriptFile, shell = '/bin/sh' }) {
  fs.writeFileSync(scriptFile, SWAP_SCRIPT);
  spawn(shell, [scriptFile, String(pid), appPath, newApp, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref();
}
