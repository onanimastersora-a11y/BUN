// The UI talks to the backend only through this module.
// In Electron it goes over IPC (window.bun from preload.cjs) to the main
// process, which owns the replica and the cloud sync. In a browser (the
// iPhone/web app, or `npm run web`) the same Backend + CloudSync run in-page,
// stored in localStorage.

import { Backend } from '../core/backend.js';
import { CloudSync } from '../core/cloud.js';
import { CLOUD_URL } from '../core/config.js';


function storageKV(key) {
  return {
    load() {
      try {
        return JSON.parse(localStorage.getItem(key));
      } catch {
        return null;
      }
    },
    save(v) {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {}
    },
  };
}

function cloudBase() {
  // Served by the BUN site itself: same origin. Local development: the
  // deployed cloud, or another one set in localStorage 'bun-cloud-url'.
  let override = null;
  try {
    override = localStorage.getItem('bun-cloud-url');
  } catch {}
  if (override) return override;
  return /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? CLOUD_URL : '';
}

function browserBridge() {
  const KEY = 'bun-db';
  const listeners = new Map();
  const emit = (channel, payload) => (listeners.get(channel) || []).forEach((cb) => cb(payload));
  const backend = new Backend(storageKV(KEY));
  backend.onChange(({ topics }) => emit('bun:changed', topics));
  const cloud = new CloudSync(backend, { baseUrl: cloudBase(), kv: storageKV('bun-cloud') });
  cloud.onStatus((status) => emit('bun:cloud', status));
  cloud.start();
  // Come back to the app (iPhone) or the network: catch up right away.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && cloud.sync().catch(() => {}));
  window.addEventListener('online', () => cloud.sync().catch(() => {}));
  // Keep two tabs of the same browser in sync.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue) return;
    backend.db = JSON.parse(e.newValue);
    emit('bun:changed', ['session', 'settings', 'boards', 'tasks', 'friends', 'chat', 'notes']);
  });
  window.__bunBackend = backend;
  window.__bunCloud = cloud;
  return {
    isElectron: false,
    call: (method, ...args) => cloud.call(method, args),
    on(channel, cb) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(cb);
      return () => listeners.set(channel, listeners.get(channel).filter((x) => x !== cb));
    },
    send() {},
    invoke: async () => null,
    emit,
  };
}

export const bridge = window.bun || browserBridge();

// api.listBoards(), api.createTask({...}) ...
export const api = new Proxy(
  {},
  {
    get: (_t, method) => (...args) => bridge.call(method, ...args),
  },
);
