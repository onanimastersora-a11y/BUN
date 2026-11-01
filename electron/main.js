// BUN - Electron main process (Windows + macOS).
// Owns the data (Backend + JSON file), the two windows (main app and desktop
// pet), the tray / menu-bar icon, start-at-login, bun:// links, the reminder
// loop, market-data fetching (no CORS here) and the user's ringtone files.

import { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage, net, powerMonitor, protocol, screen, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Backend, API_METHODS } from '../src/core/backend.js';
import { CloudSync } from '../src/core/cloud.js';
import { CLOUD_URL } from '../src/core/config.js';
import { dayKey } from '../src/core/time.js';
import { fileStorage, jsonFile } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV = !!process.env.BUN_DEV;
const DEV_URL = 'http://localhost:5173';
const IS_MAC = process.platform === 'darwin';
const AUTOSTART_FLAG = '--autostart';
const PET_SIZE = { width: 380, height: 500 };
// Hosts the renderer may read JSON from through the main process.
const NET_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'edge-api.pnj.io', 'api.open-meteo.com', 'geocoding-api.open-meteo.com', 'open.er-api.com'];
const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };

app.setAppUserModelId('app.bun.desktop');
// Separate data folder for development / testing several accounts.
if (process.env.BUN_USER_DATA) app.setPath('userData', process.env.BUN_USER_DATA);
// bunmedia://<file> serves the user's own ringtone files to the pages.
protocol.registerSchemesAsPrivileged([{ scheme: 'bunmedia', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  let backend;
  let cloud;
  let storage;
  let machine;
  let mainWin = null;
  let petWin = null;
  let petReady = false;
  let tray = null;
  let quitting = false;
  let pendingLink = null;
  let lastDayChecked = null;
  let shownTrayHint = false;
  const alertQueue = [];

  const assetPath = (name) => path.join(__dirname, 'assets', name);
  const ringtoneDir = () => path.join(app.getPath('userData'), 'ringtones');
  const loadPage = (win, page) =>
    DEV ? win.loadURL(`${DEV_URL}/${page}`) : win.loadFile(path.join(__dirname, '..', 'dist', page));

  const session = () => {
    const id = backend.db.session?.userId;
    return id ? backend.db.users[id] : null;
  };
  const settings = () => (session() ? backend.settingsFor(session().id) : null);
  const vi = () => settings()?.language !== 'en';

  // ---------- links ----------

  // Register bun:// links for the installed app only, so dev runs don't touch the registry.
  if (app.isPackaged) app.setAsDefaultProtocolClient('bun');

  const findLink = (argv) => argv.find((a) => a.startsWith('bun://'));

  function handleLink(url) {
    if (!url) return;
    pendingLink = url;
    showMain();
    if (mainWin && !mainWin.webContents.isLoading()) mainWin.webContents.send('bun:link', url);
  }

  // macOS delivers links through an event instead of argv.
  app.on('open-url', (e, url) => {
    e.preventDefault();
    if (app.isReady()) handleLink(url);
    else pendingLink = url;
  });

  // ---------- main window ----------

  function titleBarColors() {
    const dark = settings()?.theme === 'dark';
    return dark ? { color: '#15171c', symbolColor: '#ece6df', height: 40 } : { color: '#f6f2ec', symbolColor: '#2f2a26', height: 40 };
  }

  function createMain() {
    mainWin = new BrowserWindow({
      width: 1320,
      height: 840,
      minWidth: 1040,
      minHeight: 680,
      show: false,
      title: 'BUN',
      icon: assetPath('icon.png'),
      backgroundColor: titleBarColors().color,
      ...(IS_MAC
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } }
        : { titleBarStyle: 'hidden', titleBarOverlay: titleBarColors() }),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
    });
    mainWin.once('ready-to-show', () => mainWin.show());
    // Coming back to BUN: fetch what other devices changed right away.
    mainWin.on('focus', () => cloud?.sync().catch(() => {}));
    mainWin.on('close', (e) => {
      if (quitting) return;
      // Closing the window keeps BUN (and the pet) alive in the tray / menu bar.
      e.preventDefault();
      mainWin.hide();
      if (!shownTrayHint && tray && session() && !IS_MAC) {
        shownTrayHint = true;
        tray.displayBalloon({
          iconType: 'info',
          title: 'BUN',
          content: vi() ? 'BUN vẫn chạy ở khay hệ thống cùng thú cưng của bạn.' : 'BUN keeps running in the tray with your pet.',
        });
      }
    });
    mainWin.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http')) shell.openExternal(url);
      return { action: 'deny' };
    });
    loadPage(mainWin, 'index.html');
  }

  function showMain() {
    if (IS_MAC) app.dock?.show();
    if (!mainWin || mainWin.isDestroyed()) createMain();
    else {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
  }

  // ---------- pet window ----------

  // The pet window is a fixed-size transparent box that always stays fully
  // inside one screen's work area (macOS won't let windows go above the menu
  // bar). The pet itself is placed anywhere inside it: `petAnchor` is the
  // screen point under the pet's feet, kept so the whole pet stays visible.
  let petAnchor = null;
  let petBox = { w: 144, h: 120 }; // sprite size at the current scale, reported by the page

  function defaultAnchor() {
    const { workArea: wa } = screen.getPrimaryDisplay();
    return { x: wa.x + wa.width - 130, y: wa.y + wa.height - 12 };
  }

  function placePet() {
    if (!petWin || petWin.isDestroyed()) return;
    const a = petAnchor || defaultAnchor();
    const wa = screen.getDisplayNearestPoint({ x: Math.round(a.x), y: Math.round(a.y) }).workArea;
    const halfW = petBox.w / 2 + 6;
    // Room above the feet for the pet growing 1.35x during a reminder.
    const needUp = petBox.h * 1.4 + 6;
    petAnchor = {
      x: Math.min(Math.max(a.x, wa.x + halfW), wa.x + wa.width - halfW),
      y: Math.min(Math.max(a.y, wa.y + needUp), wa.y + wa.height - 4),
    };
    const W = Math.min(PET_SIZE.width, wa.width);
    const H = Math.min(PET_SIZE.height, wa.height);
    const x = Math.round(Math.min(Math.max(petAnchor.x - W / 2, wa.x), wa.x + wa.width - W));
    const y = Math.round(Math.min(Math.max(petAnchor.y + 8 - H, wa.y), wa.y + wa.height - H));
    petWin.setBounds({ x, y, width: W, height: H });
    petWin.webContents.send('pet:place', { x: Math.round(petAnchor.x - x), y: Math.round(petAnchor.y - y), width: W, height: H });
  }

  function createPet({ show = true } = {}) {
    if (petWin && !petWin.isDestroyed()) return;
    const saved = machine.get('petAnchor');
    petAnchor = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
    const a = petAnchor || defaultAnchor();
    petReady = false;
    petWin = new BrowserWindow({
      ...PET_SIZE,
      x: Math.round(a.x - PET_SIZE.width / 2),
      y: Math.round(a.y - PET_SIZE.height + 8),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      title: 'BUN Pet',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        // The ringtone has to start on its own when a reminder fires.
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    petWin.setAlwaysOnTop(true, 'floating');
    // On macOS keep the pet on every Space and above full-screen apps.
    if (IS_MAC) petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    petWin.setIgnoreMouseEvents(true, { forward: true });
    petWin.once('ready-to-show', () => {
      if (show) petWin.showInactive();
    });
    petWin.on('closed', () => {
      petWin = null;
      petReady = false;
    });
    loadPage(petWin, 'pet.html');
  }

  function destroyPet() {
    if (petWin && !petWin.isDestroyed()) petWin.destroy();
    petWin = null;
  }

  function showPet() {
    if (!session()) return;
    if (!petWin) createPet();
    else petWin.showInactive();
  }

  // Alerts bring the pet back even if the user closed it with its X button.
  function flushAlerts() {
    if (!petWin || !petReady) return;
    if (!petWin.isVisible()) petWin.showInactive();
    while (alertQueue.length) petWin.webContents.send('pet:alert', alertQueue.shift());
  }

  function pushAlert(alert) {
    alertQueue.push(alert);
    if (!petWin) createPet();
    flushAlerts();
    // Also a quiet system notification, in case the pet is behind a full-screen app.
    if (alert.kind === 'task' && Notification.isSupported()) {
      const body = vi()
        ? `Chủ nhân ơi, công việc “${alert.task.name}” sẽ diễn ra trong ${alert.task.minutes} phút tới!`
        : `“${alert.task.name}” starts in ${alert.task.minutes} minutes!`;
      new Notification({ title: 'BUN 🐾', body, silent: true, icon: assetPath('icon.png') }).show();
    }
  }

  // ---------- tray / menu bar ----------

  function buildTray() {
    if (tray) return;
    const image = IS_MAC ? nativeImage.createFromPath(assetPath('trayTemplate.png')) : nativeImage.createFromPath(assetPath('tray.png'));
    if (IS_MAC) image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip('BUN');
    tray.on('double-click', showMain);
    refreshTrayMenu();
  }

  function refreshTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: vi() ? 'Mở BUN' : 'Open BUN', click: showMain },
        { label: vi() ? 'Hiện thú cưng' : 'Show pet', click: showPet, enabled: !!session() },
        { type: 'separator' },
        {
          label: vi() ? 'Thoát' : 'Quit',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  }

  // macOS needs an app menu for Cmd+C / Cmd+V / Cmd+Q to work in text fields.
  function buildAppMenu() {
    if (!IS_MAC) return Menu.setApplicationMenu(null);
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]),
    );
  }

  // ---------- start at login ----------

  function applyAutostart() {
    if (DEV || !app.isPackaged) return;
    const s = settings();
    const openAtLogin = !!(s && s.autostart);
    if (IS_MAC) app.setLoginItemSettings({ openAtLogin });
    else app.setLoginItemSettings({ openAtLogin, args: [AUTOSTART_FLAG] });
  }

  function launchedAtLogin() {
    if (process.argv.includes(AUTOSTART_FLAG)) return true;
    if (!IS_MAC) return false;
    // macOS login items get no arguments; fall back to "the Mac just booted".
    try {
      if (app.getLoginItemSettings().wasOpenedAtLogin) return true;
    } catch {}
    return os.uptime() < 180;
  }

  // ---------- reminders + daily note recap ----------

  async function tick() {
    if (!session()) return;
    try {
      const today = dayKey();
      if (today !== lastDayChecked) {
        lastDayChecked = today;
        const recap = await backend.takeDailyRecap(today);
        if (recap) pushAlert({ kind: 'recap', ...recap });
      }
      for (const task of await backend.takeDueReminders()) pushAlert({ kind: 'task', task });
    } catch (err) {
      console.error('[bun] reminder tick failed', err);
    }
  }

  // ---------- react to data changes ----------

  let lastUserId = null;
  let lastAnimal = null;
  function onDataChanged({ topics }) {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('bun:changed', topics);
    if (topics.includes('session')) {
      const user = session();
      if (!user) {
        destroyPet();
        lastUserId = null;
        lastAnimal = null;
      } else if (user.id !== lastUserId || user.animal !== lastAnimal) {
        // New account, switched account or switched cat <-> dog: fresh pet.
        const sameUser = user.id === lastUserId;
        destroyPet();
        lastUserId = user.id;
        lastAnimal = user.animal;
        createPet();
        buildTray();
        if (!sameUser) {
          lastDayChecked = null;
          setTimeout(tick, 1500);
        }
      }
    }
    if (topics.includes('settings') || topics.includes('session')) {
      applyAutostart();
      refreshTrayMenu();
      if (mainWin && !mainWin.isDestroyed()) {
        try {
          if (!IS_MAC) mainWin.setTitleBarOverlay(titleBarColors());
          mainWin.setBackgroundColor(titleBarColors().color);
        } catch {}
      }
    }
  }

  // ---------- IPC ----------

  const CLOUD_METHODS = ['cloudStatus', 'linkAccount', 'syncNow'];
  ipcMain.handle('bun:api', async (_e, method, args) => {
    if (!API_METHODS.includes(method) && !CLOUD_METHODS.includes(method)) return { ok: false, code: 'UNKNOWN_METHOD', message: method };
    try {
      return { ok: true, data: await cloud.call(method, args || []) };
    } catch (err) {
      return { ok: false, code: err.code || 'ERROR', message: err.message };
    }
  });

  ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion() }));

  // Market data / weather: fetched here because the pages are bound by CORS.
  ipcMain.handle('net:json', async (_e, url) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !NET_HOSTS.includes(u.hostname)) throw new Error('host not allowed');
    const res = await net.fetch(u.toString(), { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BUN/1.0', accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });

  // Save an audio file the user picked as their ringtone.
  ipcMain.handle('ringtone:import', async (_e, { name, data }) => {
    const ext = path.extname(String(name || '')).toLowerCase();
    if (!AUDIO_TYPES[ext]) throw new Error('unsupported audio type');
    if (!data || data.byteLength > 30 * 1024 * 1024) throw new Error('file too large');
    fs.mkdirSync(ringtoneDir(), { recursive: true });
    for (const f of fs.readdirSync(ringtoneDir())) fs.rmSync(path.join(ringtoneDir(), f), { force: true });
    const fileId = `tone-${Date.now()}${ext}`;
    fs.writeFileSync(path.join(ringtoneDir(), fileId), Buffer.from(data));
    return { fileId, fileName: path.basename(name), url: `bunmedia://tone/${fileId}` };
  });

  ipcMain.handle('app:takeLink', () => {
    const link = pendingLink;
    pendingLink = null;
    return link;
  });
  ipcMain.on('app:linkHandled', () => (pendingLink = null));
  ipcMain.on('app:openMain', showMain);
  ipcMain.on('app:showPet', showPet);
  ipcMain.on('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });

  ipcMain.on('pet:ready', () => {
    petReady = true;
    placePet();
    flushAlerts();
  });
  ipcMain.on('pet:size', (_e, box) => {
    if (!box || !Number.isFinite(box.w) || !Number.isFinite(box.h)) return;
    petBox = { w: box.w, h: box.h };
    placePet();
  });
  ipcMain.on('pet:ignoreMouse', (_e, ignore) => {
    if (petWin && !petWin.isDestroyed()) petWin.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('pet:moveBy', (_e, delta) => {
    const dx = Number(delta?.dx);
    const dy = Number(delta?.dy);
    if (!petWin || petWin.isDestroyed() || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const a = petAnchor || defaultAnchor();
    petAnchor = { x: a.x + dx, y: a.y + dy };
    placePet();
  });
  ipcMain.on('pet:dragEnd', () => {
    if (petAnchor) machine.set('petAnchor', petAnchor);
  });
  ipcMain.on('pet:hide', () => {
    if (petWin && !petWin.isDestroyed()) petWin.hide();
  });
  ipcMain.on('pet:focus', () => {
    if (petWin && !petWin.isDestroyed()) petWin.focus();
  });
  ipcMain.on('pet:openBoard', (_e, boardId) => {
    showMain();
    if (mainWin) mainWin.webContents.send('bun:navigate', { view: 'board', boardId });
  });

  // ---------- lifecycle ----------

  app.on('second-instance', (_e, argv) => {
    const link = findLink(argv);
    if (link) handleLink(link);
    else if (!argv.includes(AUTOSTART_FLAG)) showMain();
  });

  // Clicking the Dock icon on macOS.
  app.on('activate', showMain);

  app.on('before-quit', () => {
    quitting = true;
    storage?.flush();
  });

  app.on('window-all-closed', () => {
    // Stay alive in the tray; quitting happens from the tray menu.
    if (!session()) app.quit();
  });

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    storage = fileStorage(path.join(userData, 'bun-db.json'));
    machine = jsonFile(path.join(userData, 'machine.json'), {});
    backend = new Backend(storage);
    backend.onChange(onDataChanged);
    // Accounts and data are shared with the cloud (same account on every device).
    cloud = new CloudSync(backend, {
      baseUrl: process.env.BUN_CLOUD_URL || CLOUD_URL,
      kv: jsonFile(path.join(userData, 'cloud.json'), {}).asStore(),
      fetch: (url, init) => net.fetch(url, init),
    });
    cloud.onStatus((status) => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('bun:cloud', status);
    });
    cloud.start();
    powerMonitor.on('resume', () => cloud.sync().catch(() => {}));
    buildAppMenu();

    protocol.handle('bunmedia', (req) => {
      const file = path.join(ringtoneDir(), path.basename(new URL(req.url).pathname));
      if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    // Monitors plugged in / out or resolution changed: keep the pet visible.
    for (const evt of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(evt, () => placePet());

    const autostarted = launchedAtLogin();
    const link = findLink(process.argv) || pendingLink;
    if (link) pendingLink = link;

    if (session()) {
      lastUserId = session().id;
      lastAnimal = session().animal;
      buildTray();
      createPet();
      applyAutostart();
    }
    if (!autostarted || link) createMain();
    else if (!session()) app.quit();
    // On macOS an app started at login stays out of the Dock until opened.
    if (IS_MAC && autostarted && !link) app.dock?.hide();

    setTimeout(tick, 2500);
    setInterval(tick, 15000);
  });
}
