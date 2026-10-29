// Run: node worker/push.test.mjs   (or: npm test)
//
// Proves the Web Push crypto in push.js before it ever talks to Apple:
//  1. RFC 8291 Appendix A: every intermediate value and the exact final message bytes.
//  2. Independent decryption with node:crypto (a second implementation) of our output.
//  3. VAPID JWT (RFC 8292) verifies with the public key, via WebCrypto and node:crypto.
//  4. sendWebPush() sends the right headers and a body the subscriber can decrypt.

import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import {
  b64urlDecode,
  b64urlEncode,
  createVapidJwt,
  deriveContentKeys,
  encodeNotification,
  encryptPayload,
  importP256PrivateKey,
  sendWebPush,
  vapidAuthorization,
  getVapidSigningKey,
  MAX_PLAINTEXT,
} from './push.js';

// RFC values are printed with whitespace for line wrapping; strip it.
const rfc = (s) => b64urlDecode(s.replace(/\s+/g, ''));

// ---- RFC 8291, Section 5 and Appendix A -------------------------------------------------------
const V = {
  plaintext: rfc('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
  asPublic: rfc(`BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg
                 Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8`),
  asPrivate: rfc('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  uaPublic: rfc(`BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx
                 aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4`),
  uaPrivate: rfc('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'),
  salt: rfc('DGv6ra1nlYgDCS1FRnbzlw'),
  auth: rfc('BTBZMqHH6r4Tts7J_aSIgg'),
  ecdhSecret: rfc('kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs'),
  ikm: rfc('S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg'),
  cek: rfc('oIhVW04MRdy2XN9CiKLxTg'),
  nonce: rfc('4h_95klXJ5E_qnoN'),
  header: rfc(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
               mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`),
  ciphertext: rfc(`8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs
                   bI_0LpXMuGvnzQ`),
  message: rfc(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
                mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
                pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`),
};

const hex = (u8) => Buffer.from(u8).toString('hex');

/** Independent RFC 8291 decryption using node:crypto only (not push.js). */
function nodeDecrypt(message, uaPrivate, uaPublic, authSecret) {
  const buf = Buffer.from(message);
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const record = buf.subarray(21 + idlen);
  assert.equal(rs, 4096, 'record size');
  assert.ok(record.length <= rs, 'single record fits rs');
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(uaPrivate));
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(uaPublic), asPublic]);
  const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', secret, Buffer.from(authSecret), keyInfo, 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // Strip padding: last non-zero octet must be the 0x02 delimiter (last record).
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  assert.equal(padded[end], 0x02, 'padding delimiter 0x02');
  return padded.subarray(0, end);
}

test('RFC 8291 test keys are consistent (public = d * G)', () => {
  const as = nodeCrypto.createECDH('prime256v1');
  as.setPrivateKey(Buffer.from(V.asPrivate));
  assert.equal(hex(as.getPublicKey()), hex(V.asPublic));
  const ua = nodeCrypto.createECDH('prime256v1');
  ua.setPrivateKey(Buffer.from(V.uaPrivate));
  assert.equal(hex(ua.getPublicKey()), hex(V.uaPublic));
  assert.equal(new TextDecoder().decode(V.plaintext), 'When I grow up, I want to be a watermelon');
});

test('RFC 8291 Appendix A: intermediate values (ecdh_secret, IKM, CEK, NONCE)', async () => {
  const asPrivateKey = await importP256PrivateKey(V.asPublic, V.asPrivate, 'ECDH');
  const k = await deriveContentKeys({
    uaPublic: V.uaPublic, asPublic: V.asPublic, asPrivateKey, authSecret: V.auth, salt: V.salt,
  });
  assert.equal(hex(k.ecdhSecret), hex(V.ecdhSecret), 'ecdh_secret');
  assert.equal(hex(k.ikm), hex(V.ikm), 'IKM');
  assert.equal(hex(k.cek), hex(V.cek), 'CEK');
  assert.equal(hex(k.nonce), hex(V.nonce), 'NONCE');
});

test('RFC 8291 Section 5: exact encrypted message bytes', async () => {
  const out = await encryptPayload(V.plaintext, b64urlEncode(V.uaPublic), b64urlEncode(V.auth), {
    salt: V.salt,
    senderPublicKey: V.asPublic,
    senderPrivateKey: V.asPrivate,
  });
  assert.equal(out.length, 144, 'total length (86-byte header + 41 + 1 + 16)');
  assert.equal(hex(out.subarray(0, 86)), hex(V.header), 'header');
  assert.equal(hex(out.subarray(86)), hex(V.ciphertext), 'ciphertext');
  assert.equal(hex(out), hex(V.message), 'whole message');
  assert.equal(b64urlEncode(out), b64urlEncode(V.message));
});

test('independent node:crypto decryption of the RFC message and of a random-key message', async () => {
  const fromRfc = nodeDecrypt(V.message, V.uaPrivate, V.uaPublic, V.auth);
  assert.equal(fromRfc.toString('utf8'), 'When I grow up, I want to be a watermelon');

  // Fresh subscriber keys + fresh ephemeral sender key + random salt (the production path).
  const ua = nodeCrypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  const text = JSON.stringify({ title: 'BUN 🐾', body: 'Thông báo đã hoạt động!', url: '/app/', tag: 't' });
  const a = await encryptPayload(text, b64urlEncode(ua.getPublicKey()), b64urlEncode(auth));
  const b = await encryptPayload(text, b64urlEncode(ua.getPublicKey()), b64urlEncode(auth));
  assert.notEqual(hex(a.subarray(0, 16)), hex(b.subarray(0, 16)), 'salt is random per message');
  assert.notEqual(hex(a.subarray(21, 86)), hex(b.subarray(21, 86)), 'sender key is fresh per message');
  assert.equal(nodeDecrypt(a, ua.getPrivateKey(), ua.getPublicKey(), auth).toString('utf8'), text);
  assert.equal(nodeDecrypt(b, ua.getPrivateKey(), ua.getPublicKey(), auth).toString('utf8'), text);
});

test('encryption rejects bad subscription keys and oversized payloads', async () => {
  const ua = nodeCrypto.createECDH('prime256v1');
  ua.generateKeys();
  const p256dh = b64urlEncode(ua.getPublicKey());
  const auth = b64urlEncode(nodeCrypto.randomBytes(16));
  await assert.rejects(encryptPayload('x', p256dh.slice(0, 40), auth));
  await assert.rejects(encryptPayload('x', p256dh, b64urlEncode(nodeCrypto.randomBytes(8))));
  await assert.rejects(encryptPayload('x'.repeat(MAX_PLAINTEXT + 1), p256dh, auth));
  const max = await encryptPayload('x'.repeat(MAX_PLAINTEXT), p256dh, auth);
  assert.equal(max.length, 4096, 'largest payload fills exactly 4096 bytes');
});

test('encodeNotification keeps payload under the push size limit', () => {
  const small = JSON.parse(new TextDecoder().decode(encodeNotification({ title: 'a', body: 'b', url: '/app/', tag: 'x' })));
  assert.deepEqual(small, { title: 'a', body: 'b', url: '/app/', tag: 'x' });
  const huge = encodeNotification({ title: 'Đ'.repeat(200), body: '\u0001'.repeat(500) + 'ữ'.repeat(500), url: '/app/#' + 'u'.repeat(900), tag: 't' });
  assert.ok(huge.length <= MAX_PLAINTEXT);
  const parsed = JSON.parse(new TextDecoder().decode(huge));
  assert.equal(parsed.title, 'Đ'.repeat(200));
});

// ---- VAPID ------------------------------------------------------------------------------------

async function newVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64urlEncode(await crypto.subtle.exportKey('raw', kp.publicKey));
  const privateKey = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d;
  return { publicKey, privateKey };
}

test('VAPID JWT: ES256, claims, verifies with the public key (WebCrypto and node:crypto)', async () => {
  const { publicKey, privateKey } = await newVapidKeys();
  assert.equal(b64urlDecode(publicKey).length, 65);
  assert.equal(b64urlDecode(privateKey).length, 32);
  const now = Math.floor(Date.now() / 1000);
  const { jwt, exp } = await createVapidJwt({
    audience: 'https://web.push.apple.com', subject: 'https://bun-web.workers.dev', publicKey, privateKey, nowSeconds: now,
  });
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(h))), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
  assert.deepEqual(claims, { aud: 'https://web.push.apple.com', exp: now + 12 * 3600, sub: 'https://bun-web.workers.dev' });
  assert.equal(exp, now + 12 * 3600);
  const sig = b64urlDecode(s);
  assert.equal(sig.length, 64, 'raw r||s signature');

  const pub = await crypto.subtle.importKey('raw', b64urlDecode(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const data = new TextEncoder().encode(`${h}.${c}`);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, data), 'WebCrypto verify');

  const nodePub = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64urlEncode(b64urlDecode(publicKey).subarray(1, 33)), y: b64urlEncode(b64urlDecode(publicKey).subarray(33)) }, format: 'jwk' });
  assert.ok(nodeCrypto.verify('sha256', data, { key: nodePub, dsaEncoding: 'ieee-p1363' }, sig), 'node:crypto verify');

  // Tampered claims must not verify.
  const bad = new TextEncoder().encode(`${h}.${b64urlEncode(new TextEncoder().encode(JSON.stringify({ ...claims, sub: 'x' })))}`);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, bad), false);
});

test('VAPID Authorization header uses the endpoint origin as aud', async () => {
  const vapid = { ...(await newVapidKeys()), subject: 'mailto:test@example.com' };
  const header = await vapidAuthorization('https://web.push.apple.com/QGx-abc/def?x=1', vapid);
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[2], vapid.publicKey);
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(m[1].split('.')[1])));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:test@example.com');
});

test('mismatched VAPID key pair is detected', async () => {
  const a = await newVapidKeys();
  const b = await newVapidKeys();
  await assert.rejects(getVapidSigningKey(a.publicKey, b.privateKey), /does not match|invalid|key/i);
});

test('sendWebPush: headers and a body the subscriber can decrypt', async () => {
  const vapid = { ...(await newVapidKeys()), subject: 'https://bun-web.workers.dev' };
  const ua = nodeCrypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  const sub = { endpoint: 'https://web.push.apple.com/QTEST', p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth) };
  const note = { title: 'BUN 🐾', body: 'Thông báo đã hoạt động!', url: '/app/', tag: 'bun-test' };

  const realFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(null, { status: 201 });
  };
  try {
    const res = await sendWebPush(sub, note, vapid);
    assert.equal(res.status, 201);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(captured.url, sub.endpoint);
  assert.equal(captured.init.method, 'POST');
  const hdr = captured.init.headers;
  assert.equal(hdr.TTL, '3600');
  assert.equal(hdr.Urgency, 'high');
  assert.equal(hdr['Content-Encoding'], 'aes128gcm');
  assert.match(hdr.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  const plain = nodeDecrypt(captured.init.body, ua.getPrivateKey(), ua.getPublicKey(), auth);
  assert.deepEqual(JSON.parse(plain.toString('utf8')), note);
});

test('base64url helpers', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = nodeCrypto.randomBytes(n);
    const s = b64urlEncode(bytes);
    assert.match(s, /^[\w-]*$/);
    assert.equal(hex(b64urlDecode(s)), hex(bytes));
    assert.equal(hex(b64urlDecode(bytes.toString('base64'))), hex(bytes), 'standard base64 with padding accepted');
  }
  assert.throws(() => b64urlDecode('abc$'));
  assert.throws(() => b64urlDecode('a'));
});
