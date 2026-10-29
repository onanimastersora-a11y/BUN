// Web Push for Cloudflare Workers, using only WebCrypto (also runs in Node 20+).
//
//  - VAPID (RFC 8292): ES256 JWT, sent as `Authorization: vapid t=<jwt>, k=<publicKey>`.
//  - Payload encryption (RFC 8291): ECDH P-256 + HKDF-SHA-256 + AES-128-GCM,
//    "aes128gcm" content coding (RFC 8188), one record, padding delimiter 0x02.

const enc = new TextEncoder();

export const RECORD_SIZE = 4096;
// Push services accept at most 4096 bytes of body: 86-byte header + plaintext + 0x02 + 16-byte tag.
export const MAX_PLAINTEXT = 4096 - 86 - 1 - 16; // 3993

// ---------------------------------------------------------------- base64url

export function b64urlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url (or standard base64), with or without padding. Throws on invalid input. */
export function b64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9\-_+/]*={0,2}$/.test(str)) {
    throw new Error('invalid base64url');
  }
  let s = str.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s.length % 4 === 1) throw new Error('invalid base64url length');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === 'string') return b64urlDecode(v);
  throw new Error('expected bytes or base64url string');
}

export function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- keys

function checkPublicPoint(raw, what) {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error(`${what} must be an uncompressed P-256 point (65 bytes starting with 0x04)`);
  }
}

/**
 * Imports a P-256 private key from its raw public point (65 bytes) and private scalar d (32 bytes),
 * via JWK {kty, crv, d, x, y}. `algorithm` is 'ECDSA' (VAPID signing) or 'ECDH' (encryption).
 */
export async function importP256PrivateKey(publicKey, privateKey, algorithm = 'ECDSA') {
  const pub = toBytes(publicKey);
  const d = toBytes(privateKey);
  checkPublicPoint(pub, 'public key');
  if (d.length !== 32) throw new Error('private key must be 32 bytes (raw scalar d)');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: b64urlEncode(d),
    x: b64urlEncode(pub.subarray(1, 33)),
    y: b64urlEncode(pub.subarray(33, 65)),
    ext: true,
  };
  const usages = algorithm === 'ECDH' ? ['deriveBits'] : ['sign'];
  return crypto.subtle.importKey('jwk', jwk, { name: algorithm, namedCurve: 'P-256' }, false, usages);
}

// ---------------------------------------------------------------- RFC 8291 encryption

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/**
 * RFC 8291 section 3.3/3.4 key derivation. Exported so the test can check every intermediate value.
 * @returns {Promise<{ecdhSecret: Uint8Array, ikm: Uint8Array, cek: Uint8Array, nonce: Uint8Array}>}
 */
export async function deriveContentKeys({ uaPublic, asPublic, asPrivateKey, authSecret, salt }) {
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivateKey, 256),
  );
  // key_info = "WebPush: info" || 0x00 || ua_public || as_public
  const keyInfo = concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  // IKM = HKDF(salt = auth_secret, ikm = ecdh_secret, info = key_info, L = 32)
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  // CEK / NONCE = HKDF(salt, IKM, "Content-Encoding: aes128gcm|nonce" || 0x00, 16|12)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  return { ecdhSecret, ikm, cek, nonce };
}

/**
 * Encrypts a push message body with the "aes128gcm" content coding (RFC 8291).
 *
 * @param {string|Uint8Array} payload  plaintext (string is UTF-8 encoded)
 * @param {string|Uint8Array} p256dh   subscription.keys.p256dh (user agent public key)
 * @param {string|Uint8Array} auth     subscription.keys.auth (16-byte auth secret)
 * @param {object} [opts]              test hooks only: { salt, senderPublicKey, senderPrivateKey } (raw/base64url)
 * @returns {Promise<Uint8Array>}      header (salt | rs | idlen | keyid) followed by the single encrypted record
 */
export async function encryptPayload(payload, p256dh, auth, opts = {}) {
  const plaintext = typeof payload === 'string' ? enc.encode(payload) : toBytes(payload);
  const uaPublic = toBytes(p256dh);
  const authSecret = toBytes(auth);
  checkPublicPoint(uaPublic, 'p256dh');
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');
  if (plaintext.length > MAX_PLAINTEXT) {
    throw new Error(`payload too large (${plaintext.length} > ${MAX_PLAINTEXT} bytes)`);
  }

  const salt = opts.salt ? toBytes(opts.salt) : crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('salt must be 16 bytes');

  let asPublic;
  let asPrivateKey;
  if (opts.senderPrivateKey) {
    asPublic = toBytes(opts.senderPublicKey);
    asPrivateKey = await importP256PrivateKey(asPublic, opts.senderPrivateKey, 'ECDH');
  } else {
    // A fresh ephemeral key pair for every message.
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    asPrivateKey = kp.privateKey;
  }

  const { cek, nonce } = await deriveContentKeys({ uaPublic, asPublic, asPrivateKey, authSecret, salt });
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // Single (last) record: plaintext || 0x02, no extra padding.
  const record = concatBytes(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length; // idlen = 65
  header.set(asPublic, 21); // keyid = as_public
  return concatBytes(header, ciphertext);
}

// ---------------------------------------------------------------- VAPID (RFC 8292)

const keyCache = new Map(); // "<pub>|<priv>" -> Promise<CryptoKey>
const jwtCache = new Map(); // "<pub>|<sub>|<aud>" -> { jwt, exp }

/** Imports the VAPID signing key once per isolate and checks that it matches the public key. */
export function getVapidSigningKey(publicKey, privateKey) {
  const cacheKey = `${publicKey}|${privateKey}`;
  let p = keyCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      const key = await importP256PrivateKey(publicKey, privateKey, 'ECDSA');
      // Self-check: a mismatched pair would make every push fail with 401/403 at the push service.
      const pub = await crypto.subtle.importKey(
        'raw', toBytes(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
      );
      const probe = enc.encode('bun-vapid-self-check');
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, probe);
      const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, probe);
      if (!ok) throw new Error('VAPID_PRIVATE_KEY does not match VAPID_PUBLIC_KEY');
      return key;
    })();
    p.catch(() => keyCache.delete(cacheKey));
    keyCache.set(cacheKey, p);
  }
  return p;
}

/**
 * Creates a VAPID JWT (ES256). WebCrypto ECDSA signatures are raw r||s (64 bytes), exactly what JWS wants.
 * @returns {Promise<{jwt: string, exp: number}>}
 */
export async function createVapidJwt({ audience, subject, publicKey, privateKey, nowSeconds, ttlSeconds = 12 * 3600 }) {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;
  const key = await getVapidSigningKey(publicKey, privateKey);
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: audience, exp, sub: subject })));
  const signingInput = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput));
  return { jwt: `${signingInput}.${b64urlEncode(sig)}`, exp };
}

/** `Authorization` header value for an endpoint. JWTs are reused per origin until 1 h before expiry. */
export async function vapidAuthorization(endpoint, vapid) {
  const audience = new URL(endpoint).origin;
  const cacheKey = `${vapid.publicKey}|${vapid.subject}|${audience}`;
  const now = Math.floor(Date.now() / 1000);
  let entry = jwtCache.get(cacheKey);
  if (!entry || entry.exp - now < 3600) {
    entry = await createVapidJwt({ audience, subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey, nowSeconds: now });
    jwtCache.set(cacheKey, entry);
  }
  return `vapid t=${entry.jwt}, k=${vapid.publicKey}`;
}

// ---------------------------------------------------------------- sending

function clip(str, n) {
  if (str.length <= n) return str;
  let s = str.slice(0, Math.max(0, n));
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1); // don't split a surrogate pair
  return s;
}

/** Serialises { title, body, url, tag }, shortening body (then title) if it would exceed the push size limit. */
export function encodeNotification({ title, body, url, tag }) {
  const msg = { title: String(title ?? ''), body: String(body ?? ''), url: String(url ?? ''), tag: String(tag ?? '') };
  for (let i = 0; i < 20; i++) {
    const bytes = enc.encode(JSON.stringify(msg));
    if (bytes.length <= MAX_PLAINTEXT) return bytes;
    if (msg.body.length > 0) msg.body = clip(msg.body, Math.floor(msg.body.length * 0.6));
    else if (msg.title.length > 0) msg.title = clip(msg.title, Math.floor(msg.title.length * 0.6));
    else if (msg.url.length > 5) msg.url = '/app/';
    else msg.tag = clip(msg.tag, Math.floor(msg.tag.length * 0.6));
  }
  return enc.encode(JSON.stringify({ title: 'BUN', body: '', url: '/app/', tag: '' }));
}

export class PushError extends Error {
  constructor(message, { permanent }) {
    super(message);
    this.name = 'PushError';
    this.permanent = permanent; // true: retrying will not help (bad keys, payload); false: network trouble
  }
}

/**
 * Sends one Web Push message.
 * @param {{endpoint: string, p256dh: string, auth: string}} sub
 * @param {{title: string, body: string, url: string, tag: string}} notification
 * @param {{publicKey: string, privateKey: string, subject: string}} vapid
 * @returns {Promise<{status: number, reason: string}>} the push service's HTTP status and (short) response text
 */
export async function sendWebPush(sub, notification, vapid, { ttl = 3600, urgency = 'high' } = {}) {
  let body;
  let authorization;
  try {
    body = await encryptPayload(encodeNotification(notification), sub.p256dh, sub.auth);
    authorization = await vapidAuthorization(sub.endpoint, vapid);
  } catch (err) {
    throw new PushError(`cannot build push request: ${err.message}`, { permanent: true });
  }
  let res;
  try {
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(ttl),
        Urgency: urgency,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: authorization,
      },
      body,
    });
  } catch (err) {
    throw new PushError(`push service unreachable: ${err.message}`, { permanent: false });
  }
  let reason = '';
  try {
    reason = (await res.text()).slice(0, 300);
  } catch {
    // ignore body read errors
  }
  return { status: res.status, reason };
}
