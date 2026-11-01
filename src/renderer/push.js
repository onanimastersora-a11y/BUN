// Web Push for the iPhone / web app (iOS 16.4+ once BUN is on the Home Screen).
// Web pages can't schedule notifications locally, so the device hands its
// upcoming reminders to the site's worker (web/worker), which sends each one
// at the right minute. The phone then shows it like any notification, with
// the iPhone's own sound and vibration, even when BUN is closed.

import { api, bridge } from './api.js';
import { makeT } from './i18n.js';

const DEVICE_KEY = 'bun-device-id';
const ENABLED_KEY = 'bun-push';
const HORIZON_DAYS = 14;

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

/** Ask permission (must run from a tap), subscribe and upload reminders. */
export async function enablePush() {
  if (!pushSupported()) throw Object.assign(new Error('unsupported'), { code: isIOS() && !isStandalone() ? 'PUSH_NEEDS_INSTALL' : 'PUSH_UNSUPPORTED' });
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw Object.assign(new Error('denied'), { code: 'PUSH_DENIED' });
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await fetch('/api/push/key').then((r) => r.json());
  if (!publicKey) throw Object.assign(new Error('no key'), { code: 'PUSH_SERVER' });
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  await post('subscribe', { deviceId: deviceId(), subscription: sub.toJSON() });
  store.set(ENABLED_KEY, '1');
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

/** Send the next two weeks of reminders to the worker (replaces the old list). */
export async function syncReminders() {
  if (!pushEnabled() || navigator.onLine === false) return;
  const session = await api.getSession();
  if (!session) return;
  const { leadMinutes, language } = session.settings;
  const t = makeT(language);
  const now = Date.now();
  const items = await api.listCalendar(new Date(now).toISOString(), new Date(now + HORIZON_DAYS * 864e5).toISOString());
  const reminders = items
    .filter((it) => !it.done)
    .map((it) => {
      const at = new Date(it.start).getTime() - leadMinutes * 60000;
      return {
        id: `${it.id}@${it.start}`,
        at: new Date(at).toISOString(),
        title: `${session.user.name} 🐾`,
        body: t(it.kind === 'deadline' ? 'pet.deadlineAlert' : 'pet.taskAlert', { name: it.name, n: leadMinutes }),
        url: '/app/',
        tag: it.id,
      };
    })
    .filter((r) => new Date(r.at).getTime() > now);
  await post('sync', { deviceId: deviceId(), reminders }).catch(() => {});
}

let timer = null;
/** Keep the worker's copy fresh: on start, when tasks change and when back online. */
export function startPushSync() {
  if (!pushSupported()) return;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(syncReminders, 2500);
  };
  soon();
  bridge.on('bun:changed', (topics) => topics.some((x) => ['tasks', 'boards', 'settings', 'session'].includes(x)) && soon());
  window.addEventListener('online', soon);
}
