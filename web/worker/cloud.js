// BUN accounts + sync: one Durable Object holds the shared database and runs
// the same Backend class as the apps (src/core/backend.js), each request as
// the signed-in user. Devices keep a replica and talk to it through
// src/core/cloud.js:
//
//   POST /api/cloud/register  { animal, name, code, starterBoard? } -> { token, snapshot }
//   POST /api/cloud/login     { name, code }                         -> { token, snapshot }
//   POST /api/cloud/batch     { ops: [{ method, args }] }  (Bearer)  -> { results, snapshot }
//   POST /api/cloud/logout    {}                           (Bearer)  -> {}
//
// The database is stored as JSON split into chunks in the object's storage.

import { Backend, BunError, WRITE_METHODS } from '../../src/core/backend.js';

const CHUNK = 900_000; // characters per stored value (values are limited to 2 MB)
const RPC_METHODS = new Set([...WRITE_METHODS, 'importData']);
const MAX_OPS = 200;
const LOGIN_WINDOW = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 12;

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
    for (const op of ops) {
      if (!op || !RPC_METHODS.has(op.method) || !Array.isArray(op.args)) {
        results.push({ ok: false, code: 'BAD_METHOD' });
        continue;
      }
      try {
        results.push({ ok: true, data: await me[op.method](...op.args) });
      } catch (err) {
        if (!(err instanceof BunError)) console.error(JSON.stringify({ event: 'cloud_op_error', method: op.method, error: String(err?.stack || err) }));
        results.push({ ok: false, code: err.code || 'ERROR' });
      }
    }
    return { results, snapshot: await me.snapshot() };
  }

  async fetch(request) {
    const route = new URL(request.url).pathname.replace(/^\/api\/cloud\//, '');
    let body = {};
    try {
      body = await request.json();
    } catch {}
    try {
      let data;
      if (route === 'register') data = await this.register(body);
      else if (route === 'login') data = await this.login(body);
      else if (route === 'batch') data = await this.batch(this.userFor(request), body.ops || []);
      else if (route === 'logout') {
        const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
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
