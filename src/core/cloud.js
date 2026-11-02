// Keeps this device's Backend (a replica) in sync with the BUN cloud
// (web/worker/cloud.js), so one account works on Windows, macOS and iPhone.
//
// - Reads always come from the replica, so the app works offline.
// - A change is applied to the replica at once, queued, and sent to the cloud
//   in order; the cloud runs it with the same Backend code and answers with a
//   fresh snapshot of everything this user can see (other devices' changes,
//   friends' messages, shared boards...).
// - New tasks/boards/messages get their id on the device, so a change queued
//   offline can refer to them and a retried send is never duplicated.
// - Accounts made before the cloud existed (or offline) are "linked": the
//   user re-enters their code once and their boards/tasks/notes are uploaded.

import { BunError, WRITE_METHODS, randomId } from './backend.js';
import { dayKey } from './time.js';

const POLL_MS = 20000;
const REQUEST_MS = 25000; // a request that hangs longer counts as offline
// Actions that need the cloud's knowledge of other people / boards.
const ONLINE_ONLY = new Set(['sendFriendRequest']);

export class CloudSync {
  /**
   * @param {import('./backend.js').Backend} backend this device's replica
   * @param {{ baseUrl: string, kv: { load(): any, save(v: any): void }, fetch?: typeof fetch }} opts
   */
  constructor(backend, { baseUrl, kv, fetch: fetchImpl }) {
    this.b = backend;
    this.base = baseUrl.replace(/\/$/, '');
    this.kv = kv;
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.state = { token: null, userId: null, pending: [], pendingLink: null, lastSync: null, ...(kv.load() || {}) };
    this.online = null;
    this.syncing = null;
    this.timer = null;
    this.statusListeners = new Set();
  }

  // ---------- state ----------

  save() {
    this.kv.save(this.state);
    for (const cb of this.statusListeners) cb(this.status());
  }

  onStatus(cb) {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  get localUserId() {
    return this.b.db.session?.userId || null;
  }

  /** Signed in to a cloud account that matches the replica's user. */
  get linked() {
    return !!this.state.token && !!this.localUserId && this.state.userId === this.localUserId;
  }

  status() {
    return {
      linked: this.linked,
      // A signed-in account that exists only on this device (made offline or before the cloud).
      needsLink: !!this.localUserId && !this.linked,
      autoLinking: !!this.state.pendingLink,
      online: this.online,
      pending: this.state.pending.length,
      lastSync: this.state.lastSync,
    };
  }

  // ---------- transport ----------

  async http(path, body, auth = true) {
    let data = null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_MS);
    try {
      const res = await this.fetch(`${this.base}/api/cloud/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth && this.state.token ? { authorization: `Bearer ${this.state.token}` } : {}) },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
      data = await res.json();
    } catch {
      // network error, timeout, or not a BUN answer
    } finally {
      clearTimeout(timer);
    }
    if (!data) {
      this.setOnline(false);
      throw new BunError('NEED_ONLINE');
    }
    this.setOnline(true);
    if (!data.ok) throw new BunError(data.code || 'SERVER');
    return data.data;
  }

  setOnline(v) {
    if (this.online === v) return;
    this.online = v;
    for (const cb of this.statusListeners) cb(this.status());
  }

  // ---------- accounts ----------

  adopt({ token, snapshot }) {
    this.state = { ...this.state, token, userId: snapshot.userId, pending: [], pendingLink: null, lastSync: new Date().toISOString() };
    this.save();
    this.b.loadSnapshot(snapshot);
  }

  async register(args) {
    try {
      this.adopt(await this.http('register', args, false));
    } catch (err) {
      if (err.code !== 'NEED_ONLINE') throw err;
      // Offline: make the account on this device; it is linked automatically
      // the next time the cloud is reachable.
      await this.b.register(args);
      this.state = { ...this.state, token: null, userId: null, pending: [], pendingLink: { code: String(args.code) } };
      this.save();
    }
    return this.b.getSession();
  }

  async login(args) {
    try {
      this.adopt(await this.http('login', args, false));
      return this.b.getSession();
    } catch (err) {
      // Offline: allow the account already on this device.
      if (err.code === 'NEED_ONLINE' && (await this.b.verifyLogin(args.name, args.code))) return this.b.login(args);
      throw err;
    }
  }

  async logout() {
    if (this.state.token) this.http('logout', { pushDevice: this.state.pushDevice }).catch(() => {});
    this.state = { token: null, userId: null, pending: [], pendingLink: null, lastSync: null };
    this.save();
    return this.b.logout();
  }

  /** From now on the cloud keeps this phone's reminders current, even while BUN is closed. */
  async registerPushDevice({ deviceId, timeZone }) {
    this.state.pushDevice = deviceId;
    this.save();
    return this.http('push-device', { deviceId, timeZone });
  }

  /**
   * Link the signed-in device-only account to the cloud: sign in (or create
   * the same name + code there), then upload this device's boards, tasks and
   * notes into it.
   */
  async linkAccount(code) {
    const me = this.b.me();
    if (!(await this.b.verifyLogin(`${me.name}#${me.tag}`, code))) throw new BunError('LOGIN_FAILED');
    // The same Name#tag already in the cloud, else the same name + code
    // (linked from another device), else move this account there, keeping its ID.
    let res = null;
    let fresh = false;
    for (const name of [`${me.name}#${me.tag}`, me.name]) {
      try {
        res = await this.http('login', { name, code }, false);
        break;
      } catch (err) {
        if (err.code !== 'LOGIN_FAILED') throw err;
      }
    }
    if (!res) {
      res = await this.http('register', { animal: me.animal, name: me.name, code, tag: me.tag, starterBoard: false }, false);
      fresh = true;
    }
    const db = this.b.db;
    const boards = Object.fromEntries(Object.entries(db.boards).filter(([, b]) => b.ownerId === me.id));
    const tasks = Object.fromEntries(Object.entries(db.tasks).filter(([, t]) => (t.boardId ? !!boards[t.boardId] : t.createdBy === me.id)));
    const payload = { localUserId: me.id, boards, tasks, notes: db.notes[me.id] || {}, settings: fresh ? db.settings[me.id] || null : null };
    this.state = { ...this.state, token: res.token, userId: res.snapshot.userId, pending: [] };
    this.save();
    const out = await this.http('batch', { ops: [{ method: 'importData', args: [payload] }] });
    // Keep this device's data unless the cloud really has it now.
    if (!out.results[0]?.ok) throw new BunError(out.results[0]?.code || 'SERVER');
    this.state.pendingLink = null;
    this.state.lastSync = new Date().toISOString();
    this.save();
    this.b.loadSnapshot(out.snapshot);
    this.soon();
    return this.b.getSession();
  }

  // ---------- calls from the app ----------

  async call(method, args = []) {
    switch (method) {
      case 'register':
        return this.register(args[0]);
      case 'login':
        return this.login(args[0]);
      case 'logout':
        return this.logout();
      case 'cloudStatus':
        return this.status();
      case 'linkAccount':
        return this.linkAccount(args[0]);
      case 'syncNow':
        await this.sync();
        return this.status();
      case 'registerPushDevice':
        return this.registerPushDevice(args[0]);
    }
    if (!this.linked || !WRITE_METHODS.includes(method)) return this.b[method](...args);
    // Joining someone's board from a link: the board isn't on this device yet.
    if (ONLINE_ONLY.has(method) || (method === 'joinBoard' && !this.b.db.boards[args[0]])) return this.callNow(method, args);

    args = this.withIds(method, args);
    const result = await this.b[method](...args);
    // A toggle isn't safe to replay; send the resulting state instead.
    const op = method === 'toggleClaim' ? { method: 'updateTask', args: [args[0], { assignees: result.assignees }] } : { method, args };
    this.state.pending.push(op);
    this.save();
    this.soon();
    return result;
  }

  withIds(method, args) {
    if (method === 'createTask') return [{ ...args[0], id: args[0]?.id || randomId() }];
    if (method === 'createBoard') return [args[0], { ...(args[1] || {}), id: args[1]?.id || randomId() }];
    if (method === 'sendMessage') return [args[0], args[1], args[2] || randomId()];
    // "Today" is this device's day, not the server's (UTC) day.
    if (method === 'saveNote') return [args[0], args[1] || dayKey()];
    return args;
  }

  // Run on the cloud right away (after anything still queued).
  async callNow(method, args) {
    await this.sync();
    const out = await this.http('batch', { ops: [{ method, args }] });
    this.applySnapshot(out.snapshot);
    const r = out.results[0];
    if (!r.ok) throw new BunError(r.code);
    return r.data;
  }

  // ---------- syncing ----------

  soon(ms = 400) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync().catch(() => {}), ms);
  }

  /** Send queued changes, then take the cloud's latest snapshot. */
  async sync() {
    if (this.syncing) return this.syncing;
    const run = async () => {
      try {
        if (this.state.pendingLink && this.localUserId && !this.linked) {
          await this.linkAccount(this.state.pendingLink.code);
          return;
        }
        if (!this.linked) return;
        const ops = this.state.pending.slice(0, 200);
        const out = await this.http('batch', { ops });
        this.state.pending = this.state.pending.slice(ops.length);
        this.state.lastSync = new Date().toISOString();
        this.save();
        this.applySnapshot(out.snapshot);
        if (this.state.pending.length) this.soon(50);
      } catch (err) {
        if (err.code === 'NOT_LOGGED_IN') {
          // The cloud no longer knows this token (signed out elsewhere / reset): keep the data, ask to link again.
          this.state = { ...this.state, token: null, userId: null };
          this.save();
        }
      }
    };
    // Cleared once the run settles, never before it is stored: a run that ends
    // without waiting (not linked yet) used to leave a finished promise here
    // for good, and nothing was sent again until the app restarted.
    const p = run().finally(() => {
      if (this.syncing === p) this.syncing = null;
    });
    this.syncing = p;
    return p;
  }

  // Take the cloud copy, then replay changes made while the request was in flight.
  applySnapshot(snap) {
    const later = this.state.pending.slice();
    // Nothing new since last time (the usual 20 s poll): leave the app alone.
    const sig = JSON.stringify(snap);
    if (!later.length && sig === this.lastSig) return;
    this.lastSig = sig;
    this.b.loadSnapshot(snap);
    for (const op of later) {
      try {
        const r = this.b[op.method](...op.args);
        if (r?.catch) r.catch(() => {});
      } catch {}
    }
  }

  /** Poll every 20 s (and when back online), so other devices' changes show up. */
  start() {
    this.sync().catch(() => {});
    setInterval(() => this.sync().catch(() => {}), POLL_MS);
  }
}
