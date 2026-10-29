// BUN web backend (Cloudflare Worker, free plan).
//
//  - Static site from ./public (landing page at /, PWA at /app/). Cloudflare serves matching files
//    directly; only /api/* runs this Worker first (assets.run_worker_first in wrangler.toml).
//  - /api/yahoo/*  restricted Yahoo Finance pass-through (CORS + edge cache).
//  - /api/push/*   Web Push subscriptions and reminders in D1; a cron every minute sends due reminders.

import { b64urlDecode, b64urlEncode, PushError, sendWebPush } from './push.js';

const YAHOO_ORIGIN = 'https://query1.finance.yahoo.com';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CHART_TTL = 60; // seconds
const SEARCH_TTL = 86400; // seconds

const MAX_BODY_CHARS = 2_000_000;
const MAX_REMINDERS = 500;
const MAX_INPUT_REMINDERS = 5000;
const TITLE_MAX = 200;
const BODY_MAX = 500;
const URL_MAX = 2048;
const TAG_MAX = 128;
const ID_MAX = 128;

const MINUTE = 60_000;
const SEND_WINDOW = 30 * MINUTE; // reminders more than 30 min overdue are never sent
const RETRY_WINDOW = 5 * MINUTE; // transient push failures are retried next minute while < 5 min overdue
const RETENTION = 2 * 24 * 60 * MINUTE; // sent/expired reminders are deleted after 2 days
// Free plan: 10 ms CPU and 50 external subrequests per cron run. Each push costs ~0.3-0.5 ms CPU.
const DEFAULT_BATCH = 15;

// Known Web Push services (Apple for iOS/Safari; others so desktop browsers also work).
const PUSH_HOST_SUFFIXES = [
  'push.apple.com',
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
];

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_HEADERS, ...extraHeaders },
  });
}

const bad = (message) => new HttpError(400, message);

// ======================================================================= fetch

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return assetFallback(request, env, url);

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (path.startsWith('/api/yahoo/')) return await handleYahoo(request, url, ctx);
      if (path.startsWith('/api/push/')) return await handlePush(request, url, env);
      throw new HttpError(404, 'not found');
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ ok: false, error: err.message }, err.status, err.status === 405 ? { allow: 'GET, POST, OPTIONS' } : {});
      }
      console.error(JSON.stringify({ event: 'unhandled', path, error: String(err?.stack || err) }));
      return json({ ok: false, error: 'internal error' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    await runReminderCron(env, controller.scheduledTime);
  },
};

/**
 * Only reached when no static file matched (and the path is not /api/*).
 * For /app/<route> page navigations, serve the PWA shell so client-side routes survive a reload.
 */
async function assetFallback(request, env, url) {
  const accept = request.headers.get('accept') || '';
  const lastSegment = url.pathname.split('/').pop();
  if (
    env.ASSETS &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    url.pathname.startsWith('/app/') &&
    !lastSegment.includes('.') &&
    accept.includes('text/html')
  ) {
    const shell = await env.ASSETS.fetch(new Request(new URL('/app/', url), { method: request.method, headers: request.headers }));
    if (shell.ok) return shell;
  }
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

// ======================================================================= Yahoo proxy

const SYMBOL_RE = /^[A-Za-z0-9.^=_&-]{1,32}$/;
const RANGE_INTERVAL_RE = /^[A-Za-z0-9]{1,10}$/;

async function handleYahoo(request, url, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method not allowed');

  let upstreamUrl;
  let cacheUrl;
  let ttl;

  const chart = /^\/api\/yahoo\/chart\/([^/]+)$/.exec(url.pathname);
  if (chart) {
    let symbol;
    try {
      symbol = decodeURIComponent(chart[1]);
    } catch {
      throw bad('invalid symbol encoding');
    }
    if (!SYMBOL_RE.test(symbol)) throw bad('invalid symbol');
    // Only range and interval are forwarded; every other query parameter is dropped.
    const qs = new URLSearchParams();
    for (const name of ['range', 'interval']) {
      const v = url.searchParams.get(name);
      if (v === null || v === '') continue;
      if (!RANGE_INTERVAL_RE.test(v)) throw bad(`invalid ${name}`);
      qs.set(name, v);
    }
    const query = qs.toString() ? `?${qs}` : '';
    upstreamUrl = `${YAHOO_ORIGIN}/v8/finance/chart/${encodeURIComponent(symbol)}${query}`;
    cacheUrl = `${url.origin}/api/yahoo/chart/${encodeURIComponent(symbol)}${query}`;
    ttl = CHART_TTL;
  } else if (url.pathname === '/api/yahoo/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) throw bad('missing q');
    if (q.length > 64) throw bad('q too long');
    const query = `q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
    upstreamUrl = `${YAHOO_ORIGIN}/v1/finance/search?${query}`;
    cacheUrl = `${url.origin}/api/yahoo/search?${query}`;
    ttl = SEARCH_TTL;
  } else {
    throw new HttpError(404, 'not found');
  }

  // Cache API (works on custom domains; on *.workers.dev it is a no-op and every call goes upstream).
  const cache = caches.default;
  const cacheKey = new Request(cacheUrl, { method: 'GET' });
  const hit = await cache.match(cacheKey).catch(() => undefined);
  if (hit) {
    const res = new Response(request.method === 'HEAD' ? null : hit.body, hit);
    res.headers.set('x-bun-cache', 'HIT');
    return res;
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
  } catch (err) {
    return json({ ok: false, error: 'upstream unreachable' }, 502);
  }
  const nullBody = [101, 204, 205, 304].includes(upstream.status);
  const body = nullBody ? null : await upstream.arrayBuffer();
  const res = new Response(body, {
    status: upstream.status,
    headers: {
      'content-type': 'application/json',
      'cache-control': upstream.status === 200 ? `public, max-age=${ttl}` : 'no-store',
      'x-bun-cache': 'MISS',
      ...CORS_HEADERS,
    },
  });
  if (upstream.status === 200) {
    ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  }
  if (request.method === 'HEAD') return new Response(null, res);
  return res;
}

// ======================================================================= Push API

const DEVICE_ID_RE = /^[A-Za-z0-9._~:+/=-]{32,256}$/;

async function handlePush(request, url, env) {
  const route = url.pathname.slice('/api/push/'.length);
  const routes = ['key', 'subscribe', 'sync', 'unsubscribe', 'test'];
  if (!routes.includes(route)) throw new HttpError(404, 'not found');

  if (route === 'key') {
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    const publicKey = (env.VAPID_PUBLIC_KEY || '').trim();
    if (!publicKey) throw new HttpError(503, 'VAPID_PUBLIC_KEY is not configured');
    return json({ publicKey });
  }

  if (request.method !== 'POST') throw new HttpError(405, 'method not allowed');
  const data = await readJsonObject(request);
  const deviceId = data.deviceId;
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
    throw bad('deviceId must be a string of 32-256 characters [A-Za-z0-9._~:+/=-]');
  }
  if (!env.DB) throw new HttpError(503, 'database is not configured');

  switch (route) {
    case 'subscribe':
      return subscribe(env, deviceId, data.subscription);
    case 'sync':
      return syncReminders(env, deviceId, data.reminders);
    case 'unsubscribe':
      await removeDevices(env, [deviceId]);
      return json({ ok: true });
    case 'test':
      return sendTest(env, deviceId);
  }
  throw new HttpError(404, 'not found');
}

async function readJsonObject(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_CHARS * 4) throw new HttpError(413, 'body too large');
  let text;
  try {
    text = await request.text();
  } catch {
    throw bad('unreadable body');
  }
  if (text.length > MAX_BODY_CHARS) throw new HttpError(413, 'body too large');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw bad('body must be JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('body must be a JSON object');
  return data;
}

function isAllowedEndpoint(u) {
  const host = u.hostname.toLowerCase();
  // Local push mocks for development. A deployed Worker cannot reach these hosts anyway.
  if ((u.protocol === 'http:' || u.protocol === 'https:') && (host === 'localhost' || host === '127.0.0.1')) return true;
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

async function subscribe(env, deviceId, subscription) {
  if (!subscription || typeof subscription !== 'object') throw bad('subscription must be an object');
  const { endpoint, keys } = subscription;
  if (typeof endpoint !== 'string' || endpoint.length > URL_MAX) throw bad('subscription.endpoint must be a URL string');
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw bad('subscription.endpoint is not a valid URL');
  }
  if (!isAllowedEndpoint(endpointUrl)) throw bad('subscription.endpoint is not a known push service');
  if (!keys || typeof keys !== 'object') throw bad('subscription.keys must be an object');

  let p256dh;
  let auth;
  try {
    p256dh = b64urlDecode(keys.p256dh);
    auth = b64urlDecode(keys.auth);
  } catch {
    throw bad('subscription.keys.p256dh and .auth must be base64url strings');
  }
  if (p256dh.length !== 65 || p256dh[0] !== 0x04) throw bad('subscription.keys.p256dh must be a 65-byte P-256 point');
  if (auth.length !== 16) throw bad('subscription.keys.auth must be 16 bytes');
  try {
    await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    throw bad('subscription.keys.p256dh is not a valid P-256 point');
  }

  await env.DB.batch([
    // The same browser subscription re-registered under a new deviceId: drop the stale row.
    env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?1 AND device_id <> ?2').bind(endpoint, deviceId),
    env.DB.prepare(
      `INSERT INTO subscriptions (device_id, endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth`,
    ).bind(deviceId, endpoint, b64urlEncode(p256dh), b64urlEncode(auth), Date.now()),
  ]);
  return json({ ok: true });
}

function clip(str, n) {
  if (str.length <= n) return str;
  let s = str.slice(0, n);
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  return s;
}

function optionalString(v, field, i) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw bad(`reminders[${i}].${field} must be a string`);
  return v;
}

async function syncReminders(env, deviceId, reminders) {
  if (!Array.isArray(reminders)) throw bad('reminders must be an array');
  if (reminders.length > MAX_INPUT_REMINDERS) throw bad(`too many reminders (max ${MAX_INPUT_REMINDERS})`);
  const now = Date.now();
  const byId = new Map();

  reminders.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad(`reminders[${i}] must be an object`);
    let id = r.id;
    if (typeof id === 'number' && Number.isFinite(id)) id = String(id);
    if (typeof id !== 'string' || id.length < 1 || id.length > ID_MAX) throw bad(`reminders[${i}].id must be a string of 1-${ID_MAX} chars`);
    let at;
    if (typeof r.at === 'string') at = Date.parse(r.at);
    else if (typeof r.at === 'number') at = r.at; // also accept epoch ms
    if (!Number.isFinite(at)) throw bad(`reminders[${i}].at must be an ISO date-time`);
    at = Math.round(at);
    const title = optionalString(r.title, 'title', i) ?? '';
    const body = optionalString(r.body, 'body', i) ?? '';
    const url = optionalString(r.url, 'url', i);
    if (url !== null && url.length > URL_MAX) throw bad(`reminders[${i}].url is too long (max ${URL_MAX})`);
    const tag = optionalString(r.tag, 'tag', i);
    if (at <= now) return; // past entries are ignored
    byId.set(id, {
      id,
      at,
      title: clip(title, TITLE_MAX),
      body: clip(body, BODY_MAX),
      url: url || null,
      tag: tag ? clip(tag, TAG_MAX) : null,
    });
  });

  // Keep the 500 soonest.
  const list = [...byId.values()].sort((a, b) => a.at - b.at).slice(0, MAX_REMINDERS);
  const listJson = JSON.stringify(list);

  // Two statements, one transaction (a batch also counts as one D1 query on the free plan).
  // Unchanged rows are not rewritten, which keeps "rows written" low when the client re-syncs often.
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM reminders WHERE device_id = ?1 AND sent = 0
         AND id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`,
    ).bind(deviceId, listJson),
    env.DB.prepare(
      `INSERT INTO reminders (device_id, id, at, title, body, url, tag, sent)
         SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.at'), json_extract(value, '$.title'),
                json_extract(value, '$.body'), json_extract(value, '$.url'), json_extract(value, '$.tag'), 0
         FROM json_each(?2) WHERE true
       ON CONFLICT(device_id, id) DO UPDATE SET
         at = excluded.at, title = excluded.title, body = excluded.body, url = excluded.url, tag = excluded.tag, sent = 0
       WHERE reminders.sent <> 0 OR reminders.at <> excluded.at OR reminders.title <> excluded.title
          OR reminders.body <> excluded.body OR reminders.url IS NOT excluded.url OR reminders.tag IS NOT excluded.tag`,
    ).bind(deviceId, listJson),
  ]);
  return json({ ok: true, count: list.length });
}

async function removeDevices(env, deviceIds) {
  if (!deviceIds.length) return;
  const ids = JSON.stringify(deviceIds);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM reminders WHERE device_id IN (SELECT value FROM json_each(?1))').bind(ids),
    env.DB.prepare('DELETE FROM subscriptions WHERE device_id IN (SELECT value FROM json_each(?1))').bind(ids),
  ]);
}

function vapidFromEnv(env) {
  const publicKey = (env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = (env.VAPID_PRIVATE_KEY || '').trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: (env.VAPID_SUBJECT || '').trim() || 'https://bun-web.workers.dev' };
}

function notificationFor(row) {
  return {
    title: row.title || 'BUN',
    body: row.body || '',
    url: row.url || '/app/',
    tag: row.tag || `bun-${row.id}`,
  };
}

async function sendTest(env, deviceId) {
  const vapid = vapidFromEnv(env);
  if (!vapid) throw new HttpError(503, 'VAPID keys are not configured');
  const sub = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM subscriptions WHERE device_id = ?1').bind(deviceId).first();
  if (!sub) throw new HttpError(404, 'no subscription for this deviceId');
  let result;
  try {
    result = await sendWebPush(sub, { title: 'BUN 🐾', body: 'Thông báo đã hoạt động!', url: '/app/', tag: 'bun-test' }, vapid);
  } catch (err) {
    // permanent: server keys misconfigured (503); otherwise the push service was unreachable (502).
    const status = err instanceof PushError && err.permanent ? 503 : 502;
    console.error(JSON.stringify({ event: 'push_test_error', error: err.message }));
    return json({ ok: false, error: err.message }, status);
  }
  const gone = result.status === 404 || result.status === 410;
  if (gone) await removeDevices(env, [deviceId]);
  console.log(JSON.stringify({ event: 'push_test', status: result.status, reason: result.reason || undefined }));
  const ok = result.status >= 200 && result.status < 300;
  return json({ ok, status: result.status, ...(ok ? {} : { reason: result.reason, unsubscribed: gone }) });
}

// ======================================================================= cron

async function runWithConcurrency(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runReminderCron(env, scheduledTime = Date.now()) {
  if (!env.DB) {
    console.error(JSON.stringify({ event: 'cron', error: 'DB binding missing' }));
    return;
  }
  const now = Date.now();
  const vapid = vapidFromEnv(env);
  const limit = Math.max(1, Math.min(45, Number(env.PUSH_BATCH_LIMIT) || DEFAULT_BATCH));

  let rows = [];
  if (vapid) {
    const due = await env.DB.prepare(
      `SELECT r.rowid AS rid, r.device_id, r.id, r.at, r.title, r.body, r.url, r.tag, s.endpoint, s.p256dh, s.auth
         FROM reminders r JOIN subscriptions s ON s.device_id = r.device_id
        WHERE r.sent = 0 AND r.at <= ?1 AND r.at > ?2
        ORDER BY r.at
        LIMIT ?3`,
    ).bind(now, now - SEND_WINDOW, limit).all();
    rows = due.results || [];
  } else {
    console.error(JSON.stringify({ event: 'cron', error: 'VAPID keys not configured; skipping sends' }));
  }

  const done = []; // [rowid, at] to mark as sent
  const gone = new Set();
  const stats = { due: rows.length, sent: 0, failed: 0, retry: 0, gone: 0 };

  await runWithConcurrency(rows, 6, async (row) => {
    if (gone.has(row.device_id)) return;
    const log = { event: 'push', device: row.device_id.slice(0, 6), id: row.id, lateSec: Math.round((now - row.at) / 1000) };
    try {
      const { status, reason } = await sendWebPush(row, notificationFor(row), vapid);
      log.status = status;
      if (status === 404 || status === 410) {
        gone.add(row.device_id);
        stats.gone++;
        log.result = 'gone';
      } else if (status >= 200 && status < 300) {
        done.push([row.rid, row.at]);
        stats.sent++;
        log.result = 'sent';
      } else if ((status === 429 || status >= 500) && now - row.at < RETRY_WINDOW) {
        stats.retry++;
        log.result = 'retry';
        log.reason = reason;
      } else {
        done.push([row.rid, row.at]); // permanent failure (e.g. 400/403): don't retry every minute
        stats.failed++;
        log.result = 'failed';
        log.reason = reason;
      }
    } catch (err) {
      log.error = err.message;
      if (!(err instanceof PushError && err.permanent) && now - row.at < RETRY_WINDOW) {
        stats.retry++;
        log.result = 'retry';
      } else {
        done.push([row.rid, row.at]);
        stats.failed++;
        log.result = 'failed';
      }
    }
    console.log(JSON.stringify(log));
  });

  const stmts = [];
  if (done.length) {
    // Match on `at` too, so a reminder rescheduled by a concurrent sync is not marked sent by mistake.
    stmts.push(
      env.DB.prepare(
        `UPDATE reminders SET sent = 1
          WHERE rowid IN (SELECT json_extract(value, '$[0]') FROM json_each(?1))
            AND EXISTS (SELECT 1 FROM json_each(?1) j
                         WHERE json_extract(j.value, '$[0]') = reminders.rowid AND json_extract(j.value, '$[1]') = reminders.at)`,
      ).bind(JSON.stringify(done)),
    );
  }
  if (gone.size) {
    const ids = JSON.stringify([...gone]);
    stmts.push(env.DB.prepare('DELETE FROM reminders WHERE device_id IN (SELECT value FROM json_each(?1))').bind(ids));
    stmts.push(env.DB.prepare('DELETE FROM subscriptions WHERE device_id IN (SELECT value FROM json_each(?1))').bind(ids));
  }
  // Sent or expired reminders older than 2 days. `sent IN (0, 1)` lets SQLite use the (sent, at) index.
  stmts.push(env.DB.prepare('DELETE FROM reminders WHERE sent IN (0, 1) AND at < ?1').bind(now - RETENTION));
  const results = await env.DB.batch(stmts);
  const cleaned = results[results.length - 1]?.meta?.changes || 0;

  if (rows.length || cleaned) {
    console.log(JSON.stringify({ event: 'cron', scheduledTime, ...stats, cleaned }));
  }
}
