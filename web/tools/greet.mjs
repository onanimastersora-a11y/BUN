#!/usr/bin/env node
// Send a greeting (e.g. a birthday wish) to one BUN account. Its pet shows it
// wearing a party hat on every device, and phones with notifications get a push.
//
//   node web/tools/greet.mjs --to "Name#1234" --text "Happy birthday!" [--days 3]
//   node web/tools/greet.mjs --to "Name#1234" --text-file wish.txt   (UTF-8: safe for any language in any terminal)
//   node web/tools/greet.mjs --to "Name#1234" --cancel <greeting id>
//
// The server only accepts it with the BUN_ADMIN_KEY secret. --new-key makes a
// fresh random key, stores it on Cloudflare (wrangler secret put) and uses it
// for this call without printing or saving it; otherwise BUN_ADMIN_KEY must be
// set in the environment. --url sends to another server (e.g. local wrangler dev).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOUD_URL } from '../../src/core/config.js';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

const opt = args(process.argv.slice(2));
// Windows PowerShell can turn non-English text typed on the command line into "?".
if (opt['text-file']) opt.text = readFileSync(opt['text-file'], 'utf8').replace(/^﻿/, '').trim();
if (!opt.to || (!opt.text && !opt.cancel)) {
  console.error('Usage: node web/tools/greet.mjs --to "Name#1234" --text "..." [--days 3] [--new-key] [--url URL]');
  process.exit(1);
}

let key = process.env.BUN_ADMIN_KEY;
if (opt['new-key']) {
  key = randomBytes(32).toString('hex');
  const res = spawnSync(process.execPath, [resolve(WEB, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'put', 'BUN_ADMIN_KEY'], { cwd: WEB, input: key, encoding: 'utf8' });
  if (res.status !== 0) {
    console.error('wrangler secret put failed:', (res.stderr || res.stdout || '').trim());
    process.exit(1);
  }
  console.log('New admin key stored on Cloudflare.');
}
if (!key) {
  console.error('Set BUN_ADMIN_KEY, or pass --new-key.');
  process.exit(1);
}

const base = String(opt.url || CLOUD_URL).replace(/\/$/, '');
const body = { to: opt.to, text: opt.text, days: opt.days ? Number(opt.days) : undefined, cancel: opt.cancel || null };
// A new secret takes a little while to reach every Cloudflare location: until then
// the server answers as if there were no key (NOT_FOUND) or the old one (NOT_ALLOWED).
for (let attempt = 1; ; attempt++) {
  const res = await fetch(`${base}/api/admin/greet`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({ ok: false, code: `HTTP ${res.status}` }));
  if (opt['new-key'] && (out.code === 'NOT_FOUND' || out.code === 'NOT_ALLOWED') && attempt < 24) {
    if (attempt === 1) console.log('Waiting for the new key to reach Cloudflare…');
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
