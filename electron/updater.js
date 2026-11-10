// Keeps the desktop app up to date by itself from GitHub Releases. A new version
// downloads in the background, then BUN restarts into it when you press the
// button, when you quit it, while you're away from the computer, or right away
// when BUN has just started with the computer and nobody has opened it yet.
//
// Windows uses electron-updater. macOS can't (see mac-update.js).

import { app, net, powerMonitor } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { appBundlePath, canReplaceApp, compareVersions, downloadVerified, extractZip, parseUpdateInfo, startSwap } from './mac-update.js';
import { BOOT_MS, autoInstallReason } from './update-rules.js';

const FEED = 'https://github.com/onanimastersora-a11y/BUN/releases';
const FIRST_CHECK_MS = 15 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000; // right after the computer starts there may be no network yet

function windowsEngine(report) {
  let updater = null;
  const load = async () => {
    if (updater) return updater;
    ({ autoUpdater: updater } = (await import('electron-updater')).default);
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('update-available', (info) => report({ state: 'downloading', version: info.version, percent: 0 }));
    updater.on('download-progress', (p) => report({ state: 'downloading', percent: Math.round(p.percent) }));
    updater.on('update-downloaded', (info) => report({ state: 'ready', version: info.version }));
    updater.on('update-not-available', () => report({ state: 'latest' }));
    updater.on('error', () => report({ state: 'error' }));
    return updater;
  };
  return {
    check: async () => (await load()).checkForUpdates(),
    install: () => updater.quitAndInstall(true, true),
    onQuit() {}, // autoInstallOnAppQuit
  };
}

function macEngine(report, failedBefore) {
  const appPath = appBundlePath(app.getPath('exe'));
  const work = path.join(app.getPath('temp'), 'bun-update');
  const fetch = (url, init) => net.fetch(url, init);
  let newApp = null;
  const swap = (relaunch) => startSwap({ pid: process.pid, appPath, newApp, relaunch, scriptFile: path.join(work, 'swap.sh') });
  return {
    async check() {
      const res = await fetch(`${FEED}/latest/download/latest-mac.yml`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info = parseUpdateInfo(await res.text());
      if (!info.version || !info.path || !info.sha512) throw new Error('bad update info');
      if (compareVersions(info.version, app.getVersion()) <= 0) return report({ state: 'latest' });
      if (!canReplaceApp(appPath) || failedBefore(info.version)) return report({ state: 'manual', version: info.version });
      report({ state: 'downloading', version: info.version, percent: 0 });
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
      const zip = path.join(work, path.basename(info.path));
      await downloadVerified({
        fetch,
        url: `${FEED}/download/v${info.version}/${encodeURIComponent(info.path)}`,
        sha512: info.sha512,
        file: zip,
        onProgress: (percent) => report({ state: 'downloading', percent }),
      });
      await extractZip(zip, path.join(work, 'new'));
      fs.rmSync(zip, { force: true });
      const found = path.join(work, 'new', path.basename(appPath));
      if (!fs.existsSync(path.join(found, 'Contents', 'MacOS'))) throw new Error('no app in the update');
      newApp = found;
      report({ state: 'ready', version: info.version });
    },
    install() {
      swap(true);
      app.quit();
    },
    onQuit() {
      if (newApp) swap(false);
    },
  };
}

/**
 * @param {{ machine: { get(k: string): any, set(k: string, v: any): void }, isMainVisible: () => boolean, beforeQuit: () => void, onStatus: (s: object) => void, startedAtLogin?: boolean }} opts
 */
export function startUpdater({ machine, isMainVisible, beforeQuit, onStatus, startedAtLogin = false }) {
  const current = app.getVersion();
  const started = Date.now();
  const bootUntil = startedAtLogin ? started + BOOT_MS : 0;
  let status = { state: 'idle', current, platform: process.platform };
  let installing = false;
  let userAsked = false;
  let failed = false;

  // BUN restarted into the same old version: installing that one failed, so don't keep restarting.
  const failedBefore = (version) => machine.get('updateTried') === version && compareVersions(version, current) > 0;

  const report = (patch) => {
    if (patch.state === 'checking') failed = false;
    if (patch.state === 'error') failed = true;
    const wasReady = status.state === 'ready';
    let next = { ...status, ...patch };
    if (next.state === 'ready' && failedBefore(next.version)) next = { ...next, state: 'manual' };
    // A failed check nobody asked for (offline, say) isn't worth showing.
    if (next.state === 'error' && !userAsked) next = { ...next, state: 'idle' };
    status = next;
    onStatus(status);
    if (status.state === 'ready' && !wasReady) setTimeout(installIfFree, 3000);
  };

  const engine = process.platform === 'darwin' ? macEngine(report, failedBefore) : windowsEngine(report);

  const check = async (asked = false) => {
    if (['checking', 'downloading', 'ready'].includes(status.state)) return status;
    userAsked = asked;
    report({ state: 'checking' });
    try {
      await engine.check();
    } catch {
      report({ state: 'error' });
    }
    return status;
  };

  const install = ({ away = false } = {}) => {
    if (status.state !== 'ready' || installing) return;
    installing = true;
    machine.set('updateTried', status.version);
    // Restarted while nobody was looking: come back quietly, like at login.
    if (away && !isMainVisible()) machine.set('restartHidden', true);
    beforeQuit();
    engine.install();
  };

  function installIfFree() {
    if (status.state !== 'ready' || !app.isPackaged) return;
    const reason = autoInstallReason({ now: Date.now(), bootUntil, mainVisible: isMainVisible(), idleSeconds: powerMonitor.getSystemIdleTime() });
    if (reason) install({ away: true });
  }

  if (app.isPackaged) {
    setTimeout(check, FIRST_CHECK_MS);
    setInterval(check, CHECK_EVERY_MS);
    setInterval(() => {
      if (failed && Date.now() - started < BOOT_MS) check();
    }, RETRY_MS);
    powerMonitor.on('resume', () => check());
    setInterval(installIfFree, 60 * 1000);
    app.on('will-quit', () => {
      if (status.state === 'ready' && !installing) engine.onQuit();
    });
  }

  return { status: () => status, check: () => check(true), install: () => install() };
}
