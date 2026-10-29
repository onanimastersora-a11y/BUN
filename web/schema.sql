-- BUN push storage (Cloudflare D1 / SQLite).
-- Remote: npm run db:init        Local (wrangler dev): npm run db:init:local
-- Safe to run more than once.

-- One Web Push subscription per device. device_id is the client's random secret (its only credential).
CREATE TABLE IF NOT EXISTS subscriptions (
  device_id  TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,   -- base64url, 65-byte uncompressed P-256 point
  auth       TEXT NOT NULL,   -- base64url, 16 bytes
  created_at INTEGER NOT NULL -- epoch ms
);

-- Reminders to push. `at` is epoch milliseconds (UTC).
CREATE TABLE IF NOT EXISTS reminders (
  device_id TEXT NOT NULL,
  id        TEXT NOT NULL,
  at        INTEGER NOT NULL,
  title     TEXT NOT NULL DEFAULT '',
  body      TEXT NOT NULL DEFAULT '',
  url       TEXT,
  tag       TEXT,
  sent      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, id)
);

-- The cron (every minute) looks up unsent reminders by time.
CREATE INDEX IF NOT EXISTS idx_reminders_sent_at ON reminders (sent, at);
