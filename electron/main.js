// BUN - Electron main process (Windows + macOS).
// Owns the data (Backend + JSON file), the two windows (main app and desktop
// pet), the tray / menu-bar icon, start-at-login, bun:// links, the reminder
// loop, market-data fetching (no CORS here) and the user's ringtone files.

import { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage, net, protocol, screen, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Backend, API_METHODS } from '../src/core/backend.js';
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

  function defaultPetPosition() {
    const { workArea } = screen.getPrimaryDisplay();
    return { x: workArea.x + workArea.width - PET_SIZE.width - 24, y: workArea.y + workArea.height - PET_SIZE.height + 8 };
  }

  function clampPetPosition({ x, y }) {
    // Keep at least the pet itself (bottom-center of the window) on some screen.
    const display = screen.getDisplayNearestPoint({ x: x + PET_SIZE.width / 2, y: y + PET_SIZE.height - 60 });
    const wa = display.workArea;
    return {
      x: Math.round(Math.min(Math.max(x, wa.x - PET_SIZE.width / 2 + 60), wa.x + wa.width - PET_SIZE.width / 2 - 60)),
      y: Math.round(Math.min(Math.max(y, wa.y - PET_SIZE.height + 160), wa.y + wa.height - PET_SIZE.height + 30)),
    };
  }

  function createPet({ show = true } = {}) {
    if (petWin && !petWin.isDestroyed()) return;
    const pos = clampPetPosition(machine.get('petPos') || defaultPetPosition());
    petReady = false;
    petWin = new BrowserWindow({
      ...PET_SIZE,
      ...pos,
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

  ipcMain.handle('bun:api', async (_e, method, args) => {
    if (!API_METHODS.includes(method)) return { ok: false, code: 'UNKNOWN_METHOD', message: method };
    try {
      return { ok: true, data: await backend[method](...(args || [])) };
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
    flushAlerts();
  });
  ipcMain.on('pet:ignoreMouse', (_e, ignore) => {
    if (petWin && !petWin.isDestroyed()) petWin.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('pet:moveBy', (_e, { dx, dy }) => {
    if (!petWin || petWin.isDestroyed()) return;
    const [x, y] = petWin.getPosition();
    petWin.setPosition(Math.round(x + dx), Math.round(y + dy));
  });
  ipcMain.on('pet:dragEnd', () => {
    if (!petWin || petWin.isDestroyed()) return;
    const [x, y] = petWin.getPosition();
    const pos = clampPetPosition({ x, y });
    petWin.setPosition(pos.x, pos.y);
    machine.set('petPos', pos);
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
    buildAppMenu();

    protocol.handle('bunmedia', (req) => {
      const file = path.join(ringtoneDir(), path.basename(new URL(req.url).pathname));
      if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

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
