// Bridge between the sandboxed pages and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['bun:changed', 'bun:cloud', 'bun:link', 'bun:navigate', 'pet:alert', 'pet:place'];
const SENDS = ['app:openMain', 'app:showPet', 'app:linkHandled', 'app:openExternal', 'pet:ready', 'pet:size', 'pet:ignoreMouse', 'pet:moveBy', 'pet:dragEnd', 'pet:hide', 'pet:focus', 'pet:openBoard'];
const INVOKES = ['app:takeLink', 'app:info', 'net:json', 'ringtone:import'];

contextBridge.exposeInMainWorld('bun', {
  isElectron: true,
  async call(method, ...args) {
    const res = await ipcRenderer.invoke('bun:api', method, args);
    if (!res.ok) {
      const err = new Error(res.message || res.code);
      err.code = res.code;
      throw err;
    }
    return res.data;
  },
  on(channel, cb) {
    if (!EVENTS.includes(channel)) throw new Error(`blocked channel ${channel}`);
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  send(channel, payload) {
    if (SENDS.includes(channel)) ipcRenderer.send(channel, payload);
  },
  invoke(channel, payload) {
    if (INVOKES.includes(channel)) return ipcRenderer.invoke(channel, payload);
    return Promise.reject(new Error(`blocked channel ${channel}`));
  },
});
