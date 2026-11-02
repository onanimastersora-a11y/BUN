// A device's list of reminders to push, in D1. The cron in index.js sends them.

const MAX_REMINDERS = 500;

/** Replace the device's unsent reminders with `list` (the 500 soonest are kept). */
export async function replaceReminders(env, deviceId, list) {
  const listJson = JSON.stringify([...list].sort((a, b) => a.at - b.at).slice(0, MAX_REMINDERS));

  // Two statements, one transaction (a batch also counts as one D1 query on the free plan).
  // Unchanged rows are not rewritten, which keeps "rows written" low when the list is refreshed often.
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
  return Math.min(list.length, MAX_REMINDERS);
}
