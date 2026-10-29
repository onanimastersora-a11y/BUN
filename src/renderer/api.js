// The UI talks to the backend only through this module.
// In Electron it goes over IPC (window.bun from preload.cjs). In a plain
// browser (npm run web) it runs the same Backend in-page on localStorage, so
// the whole UI can be previewed without Electron.

import { Backend } from '../core/backend.js';

function browserBridge() {
  const KEY = 'bun-db';
  const listeners = new Map();
  const emit = (channel, payload) => (listeners.get(channel) || []).forEach((cb) => cb(payload));
  const backend = new Backend({
    load: () => {
      try {
        return JSON.parse(localStorage.getItem(KEY));
      } catch {
        return null;
      }
    },
    save: (db) => {
      try {
        localStorage.setItem(KEY, JSON.stringify(db));
      } catch {}
    },
  });
  backend.onChange(({ topics }) => emit('bun:changed', topics));
  // Keep two browser tabs (e.g. main page + pet page) in sync.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    backend.db = JSON.parse(e.newValue);
    emit('bun:changed', ['session', 'settings', 'boards', 'tasks', 'friends', 'chat', 'notes']);
  });
  window.__bunBackend = backend;
  return {
    isElectron: false,
    async call(method, ...args) {
      return backend[method](...args);
    },
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
