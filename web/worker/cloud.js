// BUN accounts + sync: one Durable Object holds the shared database and runs
// the same Backend class as the apps (src/core/backend.js), each request as
// the signed-in user. Devices keep a replica and talk to it through
// src/core/cloud.js:
//
//   POST /api/cloud/register  { animal, name, code, starterBoard?, tag? } -> { token, snapshot }
//   POST /api/cloud/login     { name, code }                         -> { token, snapshot }
//   POST /api/cloud/batch     { ops: [{ method, args }] }  (Bearer)  -> { results, snapshot }
//   POST /api/cloud/logout    { pushDevice? }              (Bearer)  -> {}
//   POST /api/cloud/push-device { deviceId, timeZone }     (Bearer)  -> { count }
//
// The database is stored as JSON split into chunks in the object's storage.
//
// Phones: each registered device's reminders (D1, sent by the cron in index.js)
// are rebuilt here whenever its user's schedule changes, on any device, and once
// a day so the two-week list keeps rolling forward while BUN stays closed.

import { Backend, BunError, WRITE_METHODS } from '../../src/core/backend.js';
import { remindersFor, REMINDER_DAYS } from '../../src/core/reminders.js';
import { zoneOf } from '../../src/core/time.js';
import { makeT } from '../../src/renderer/i18n.js';
import { replaceReminders } from './reminders.js';

const CHUNK = 500_000; // characters per stored value: at most 1 MB even as UTF-16 (values are limited to 2 MB)
const RPC_METHODS = new Set([...WRITE_METHODS, 'importData']);
const MAX_OPS = 200;
const LOGIN_WINDOW = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 12;
const DEVICE_ID_RE = /^[A-Za-z0-9._~:+/=-]{32,256}$/;
// Changes that can alter what someone gets reminded about.
const REMINDER_OPS = new Set(['createTask', 'updateTask', 'deleteTask', 'skipOccurrence', 'toggleClaim', 'deleteBoard', 'leaveBoard', 'joinBoard', 'importData']);
const changesReminders = (op) => REMINDER_OPS.has(op.method) || (op.method === 'updateSettings' && ('leadMinutes' in (op.args[0] || {}) || 'language' in (op.args[0] || {})));

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class BunCloud {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.dirty = false;
    this.failures = new Map(); // name -> [timestamps] of failed logins
    ctx.blockConcurrencyWhile(async () => {
      const count = await ctx.storage.get('db:count');
      let data = null;
      if (count) {
        const keys = Array.from({ length: count }, (_, i) => `db:${i}`);
        const parts = await ctx.storage.get(keys);
        data = JSON.parse(keys.map((k) => parts.get(k)).join(''));
      }
      this.backend = new Backend({ load: () => data, save: () => (this.dirty = true) });
      this.backend.db.tokens ||= {};
      this.backend.db.pushDevices ||= {}; // deviceId -> { userId, timeZone }
    });
  }

  async persist() {
    if (!this.dirty) return;
    this.dirty = false;
    const text = JSON.stringify(this.backend.db);
    const n = Math.max(1, Math.ceil(text.length / CHUNK));
    const old = (await this.ctx.storage.get('db:count')) || 0;
    for (let i = 0; i < n; i += 100) {
      const entries = {};
      for (let j = i; j < Math.min(n, i + 100); j++) entries[`db:${j}`] = text.slice(j * CHUNK, (j + 1) * CHUNK);
      await this.ctx.storage.put(entries);
    }
    await this.ctx.storage.put('db:count', n);
    if (old > n) await this.ctx.storage.delete(Array.from({ length: old - n }, (_, i) => `db:${n + i}`));
  }

  userFor(request) {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const entry = token && this.backend.db.tokens[token];
    if (!entry || !this.backend.db.users[entry.userId]) throw new BunError('NOT_LOGGED_IN');
    entry.lastUsed = Date.now();
    return entry.userId;
  }

  issue(userId) {
    const token = newToken();
    this.backend.db.tokens[token] = { userId, createdAt: Date.now(), lastUsed: Date.now() };
    this.dirty = true;
    return token;
  }

  tooManyFailures(name) {
    const now = Date.now();
    const list = (this.failures.get(name) || []).filter((t) => now - t < LOGIN_WINDOW);
    this.failures.set(name, list);
    return list.length >= LOGIN_MAX_FAILS;
  }

  async register(body) {
    const session = await this.backend.register({
      animal: body.animal,
      name: body.name,
      code: body.code,
      starterBoard: body.starterBoard !== false,
      tag: body.tag ?? null,
    });
    const userId = session.user.id;
    this.backend.db.session = null; // the server has no "current user"
    return { token: this.issue(userId), snapshot: await this.backend.asUser(userId).snapshot() };
  }

  async login(body) {
    const key = String(body.name || '').trim().toLowerCase();
    if (this.tooManyFailures(key)) throw new BunError('TOO_MANY_TRIES');
    const user = await this.backend.verifyLogin(body.name, body.code);
    if (!user) {
      this.failures.get(key).push(Date.now());
      throw new BunError('LOGIN_FAILED');
    }
    return { token: this.issue(user.id), snapshot: await this.backend.asUser(user.id).snapshot() };
  }

  // Run a device's queued changes in order. A change the server refuses
  // (e.g. no permission any more) is skipped; the snapshot puts the device right.
  async batch(userId, ops) {
    if (!Array.isArray(ops) || ops.length > MAX_OPS) throw new BunError('BAD_REQUEST');
    const me = this.backend.asUser(userId);
    const results = [];
    let remind = false;
    for (const op of ops) {
      if (!op || !RPC_METHODS.has(op.method) || !Array.isArray(op.args)) {
        results.push({ ok: false, code: 'BAD_METHOD' });
        continue;
      }
      try {
        results.push({ ok: true, data: await me[op.method](...op.args) });
        remind ||= changesReminders(op);
      } catch (err) {
        if (!(err instanceof BunError)) console.error(JSON.stringify({ event: 'cloud_op_error', method: op.method, error: String(err?.stack || err) }));
        results.push({ ok: false, code: err.code || 'ERROR' });
      }
    }
    if (remind) this.ctx.waitUntil(this.refreshFor(userId));
    return { results, snapshot: await me.snapshot() };
  }

  // ---------- phone reminders ----------

  async pushDevice(userId, { deviceId, timeZone }) {
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) throw new BunError('BAD_REQUEST');
    this.backend.db.pushDevices[deviceId] = { userId, timeZone: String(timeZone || 'UTC').slice(0, 64) };
    this.dirty = true;
    return { count: await this.refreshDevice(deviceId) };
  }

  async dropPushDevice(userId, deviceId) {
    if (this.backend.db.pushDevices[deviceId]?.userId !== userId) return;
    delete this.backend.db.pushDevices[deviceId];
    if (this.env.DB) await replaceReminders(this.env, deviceId, []);
  }

  async refreshDevice(deviceId) {
    const entry = this.backend.db.pushDevices[deviceId];
    if (!entry || !this.env.DB) return 0;
    const subscribed = await this.env.DB.prepare('SELECT 1 FROM subscriptions WHERE device_id = ?1').bind(deviceId).first();
    if (!subscribed || !this.backend.db.users[entry.userId]) {
      delete this.backend.db.pushDevices[deviceId]; // notifications were turned off on that phone
      this.dirty = true;
      return 0;
    }
    let zone;
    try {
      zone = zoneOf(entry.timeZone);
    } catch {
      zone = zoneOf('UTC');
    }
    const me = this.backend.asUser(entry.userId, zone);
    const user = me.me();
    const { leadMinutes, language } = me.settingsFor(user.id);
    const now = Date.now();
    const items = await me.listCalendar(new Date(now).toISOString(), new Date(now + REMINDER_DAYS * 864e5).toISOString());
    return replaceReminders(this.env, deviceId, remindersFor(items, { userName: user.name, leadMinutes, t: makeT(language), now }));
  }

  // A change on a shared board can reach everyone on it (tasks assigned to them).
  async refreshFor(userId) {
    try {
      const people = new Set([userId]);
      for (const b of Object.values(this.backend.db.boards)) if (b.members[userId]) Object.keys(b.members).forEach((id) => people.add(id));
      for (const [deviceId, entry] of Object.entries(this.backend.db.pushDevices)) if (people.has(entry.userId)) await this.refreshDevice(deviceId);
      await this.persist();
    } catch (err) {
      console.error(JSON.stringify({ event: 'reminders_error', error: String(err?.stack || err) }));
    }
  }

  async refreshAll() {
    const devices = Object.keys(this.backend.db.pushDevices);
    for (const deviceId of devices) {
      try {
        await this.refreshDevice(deviceId);
      } catch (err) {
        console.error(JSON.stringify({ event: 'reminders_error', error: String(err?.stack || err) }));
      }
    }
    await this.persist();
    return devices.length;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    // From the daily cron only: handleCloud forwards nothing but /api/cloud/*.
    if (path === '/internal/refresh-reminders') return Response.json({ ok: true, devices: await this.refreshAll() });
    const route = path.replace(/^\/api\/cloud\//, '');
    let body = {};
    try {
      body = await request.json();
    } catch {}
    try {
      let data;
      if (route === 'register') data = await this.register(body);
      else if (route === 'login') data = await this.login(body);
      else if (route === 'batch') data = await this.batch(this.userFor(request), body.ops || []);
      else if (route === 'push-device') data = await this.pushDevice(this.userFor(request), body);
      else if (route === 'logout') {
        const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (body.pushDevice && this.backend.db.tokens[token]) await this.dropPushDevice(this.backend.db.tokens[token].userId, body.pushDevice);
        delete this.backend.db.tokens[token];
        this.dirty = true;
        data = {};
      } else return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
      await this.persist();
      return Response.json({ ok: true, data });
    } catch (err) {
      await this.persist();
      if (err instanceof BunError) {
        const status = err.code === 'NOT_LOGGED_IN' ? 401 : err.code === 'TOO_MANY_TRIES' ? 429 : 400;
        return Response.json({ ok: false, code: err.code }, { status });
      }
      console.error(JSON.stringify({ event: 'cloud_error', route, error: String(err?.stack || err) }));
      return Response.json({ ok: false, code: 'SERVER' }, { status: 500 });
    }
  }
}

/** Worker side: forward /api/cloud/* to the single database object. */
export async function handleCloud(request, env, corsHeaders) {
  if (!env.CLOUD) return Response.json({ ok: false, code: 'NO_CLOUD' }, { status: 503, headers: corsHeaders });
  if (request.method !== 'POST') return Response.json({ ok: false, code: 'METHOD' }, { status: 405, headers: corsHeaders });
  const stub = env.CLOUD.get(env.CLOUD.idFromName('main'));
  const res = await stub.fetch(request);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}
