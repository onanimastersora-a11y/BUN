// Generates a new VAPID key pair for Web Push.   Run: npm run vapid
//   public key  = base64url of the raw 65-byte uncompressed P-256 point (goes in wrangler.toml)
//   private key = base64url of the raw 32-byte scalar d (secret: `npx wrangler secret put VAPID_PRIVATE_KEY`)

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);
const pub = b64url(await crypto.subtle.exportKey('raw', publicKey));
const priv = (await crypto.subtle.exportKey('jwk', privateKey)).d;

if (Buffer.from(pub, 'base64url').length !== 65 || Buffer.from(priv, 'base64url').length !== 32) {
  throw new Error('unexpected key length');
}

console.log(`
VAPID_PUBLIC_KEY=${pub}
VAPID_PRIVATE_KEY=${priv}

1) Dán VAPID_PUBLIC_KEY vào web/wrangler.toml, dòng:  VAPID_PUBLIC_KEY = "${pub}"
2) Chạy:  npx wrangler secret put VAPID_PRIVATE_KEY   rồi dán VAPID_PRIVATE_KEY khi được hỏi.
   Giữ bí mật khóa riêng, không gửi cho ai và không dán vào file nào.
   Nếu đổi khóa sau khi đã có người bật thông báo, họ phải bật lại thông báo trong app.
`);
