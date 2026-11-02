// Web Push for the iPhone / web app (iOS 16.4+ once BUN is on the Home Screen).
// Web pages can't schedule notifications locally, so the site's worker
// (web/worker) sends each reminder at the right minute. The phone then shows it
// like any notification, with the iPhone's own sound and vibration, even when
// BUN is closed. For an account on the cloud, the cloud builds this phone's list
// from the schedule, so changes made on other devices count too. Otherwise the
// phone uploads its own list.

import { api, bridge } from './api.js';
import { makeT } from './i18n.js';
import { REMINDER_DAYS, remindersFor } from '../core/reminders.js';

const DEVICE_KEY = 'bun-device-id';
const ENABLED_KEY = 'bun-push';

const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};

export function deviceId() {
  let id = store.get(DEVICE_KEY);
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    store.set(DEVICE_KEY, id);
  }
  return id;
}

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const pushSupported = () => !bridge.isElectron && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const pushEnabled = () => store.get(ENABLED_KEY) === '1' && pushSupported() && Notification.permission === 'granted';

// Errors carry the server's reason (`err.detail`) so the app can show it.
async function post(path, body) {
  let res;
  try {
    res = await fetch(`/api/push/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('offline'), { code: 'PUSH_SERVER', detail: 'offline' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const detail = data.error || data.reason || `HTTP ${data.status || res.status}`;
    throw Object.assign(new Error(detail), { code: 'PUSH_SERVER', detail });
  }
  return data;
}

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Subscribe this phone and tell the worker. A subscription made with older
// server keys can't receive anything, so it is replaced.
async function subscribeDevice() {
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await fetch('/api/push/key').then((r) => r.json());
  if (!publicKey) throw Object.assign(new Error('no key'), { code: 'PUSH_SERVER' });
  const key = b64urlToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  const oldKey = sub?.options?.applicationServerKey;
  if (oldKey && new Uint8Array(oldKey).join() !== key.join()) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await post('subscribe', { deviceId: deviceId(), subscription: sub.toJSON() });
}

/** Ask permission (must run from a tap), subscribe and upload reminders. */
export async function enablePush() {
  if (!pushSupported()) throw Object.assign(new Error('unsupported'), { code: isIOS() && !isStandalone() ? 'PUSH_NEEDS_INSTALL' : 'PUSH_UNSUPPORTED' });
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw Object.assign(new Error('denied'), { code: 'PUSH_DENIED' });
  await subscribeDevice();
  store.set(ENABLED_KEY, '1');
  registeredAs = null;
  await syncReminders();
}

export async function disablePush() {
  store.set(ENABLED_KEY, null);
  try {
    const reg = await navigator.serviceWorker.ready;
    await (await reg.pushManager.getSubscription())?.unsubscribe();
  } catch {}
  await post('unsubscribe', { deviceId: deviceId() }).catch(() => {});
}

export const testPush = () => post('test', { deviceId: deviceId() });

let registeredAs = null; // who the cloud already builds this phone's reminders for

/** Make sure the worker has this phone's reminders (the next two weeks; replaces the old list). */
export async function syncReminders() {
  if (!pushEnabled() || navigator.onLine === false) return;
  const session = await api.getSession();
  if (!session) {
    registeredAs = null;
    return;
  }
  const status = await api.cloudStatus();
  if (status.linked) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const who = `${session.user.id}|${timeZone}`;
    if (registeredAs === who) return;
    await api.registerPushDevice({ deviceId: deviceId(), timeZone });
    registeredAs = who;
    return;
  }
  const { leadMinutes, language } = session.settings;
  const now = Date.now();
  const items = await api.listCalendar(new Date(now).toISOString(), new Date(now + REMINDER_DAYS * 864e5).toISOString());
  const reminders = remindersFor(items, { userName: session.user.name, leadMinutes, t: makeT(language), now });
  await post('sync', { deviceId: deviceId(), reminders }).catch(() => {});
}

let timer = null;
/** Keep the worker's copy fresh: on start, when tasks change and when back online. */
export function startPushSync() {
  if (!pushSupported()) return;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => syncReminders().catch(() => {}), 2500);
  };
  // Opening BUN repairs anything lost while it was closed (dropped subscription, new server keys).
  const refresh = () => {
    registeredAs = null;
    if (pushEnabled() && navigator.onLine !== false) subscribeDevice().catch(() => {});
    soon();
  };
  refresh();
  bridge.on('bun:changed', (topics) => topics.some((x) => ['tasks', 'boards', 'settings', 'session'].includes(x)) && soon());
  bridge.on('bun:cloud', soon); // just linked to the cloud
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
}
