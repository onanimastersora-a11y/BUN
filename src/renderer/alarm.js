// Weekly events -> repeating alarms in the iPhone's Clock app. A web app can't
// ring like an alarm (Apple keeps that to native apps), so BUN hands the schedule
// to a Shortcut, which creates the alarms. See web/SHORTCUT.md for that Shortcut.
//
// The Shortcut can only add alarms, so this phone remembers which ones it already
// added: pressing the button again never makes duplicates, and alarms whose event
// changed are listed for the user to delete in Clock.
//
// iOS tells a web app nothing about what the Shortcut did. So the button stays hidden
// until the user says the Shortcut exists (`ready`), and sent alarms wait in `pending`
// until the user says they showed up in Clock.

import { api } from './api.js';

export const SHORTCUT_NAME = 'BUN Bao thuc';

const KEY = 'bun-alarms';
const pad = (n) => String(n).padStart(2, '0');

export function loadAlarmState() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY)) || {};
    // Saved before `ready` existed: pressing the button counted as added even if the Shortcut was missing.
    return { off: [], pending: [], ...saved, ready: !!saved.ready, added: saved.ready ? saved.added || {} : {} };
  } catch {
    return { off: [], added: {}, pending: [], ready: false };
  }
}

export function saveAlarmState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}

/** One alarm per weekly event, `leadMinutes` before it starts. `day` is 0 = Monday ... 6 = Sunday. */
export async function weeklyAlarms(leadMinutes) {
  const now = Date.now();
  // Two weeks: a series whose next week was skipped still shows up.
  const items = await api.listCalendar(new Date(now).toISOString(), new Date(now + 14 * 864e5).toISOString());
  const bySeries = new Map();
  for (const it of items) {
    if (it.kind !== 'event' || it.repeat !== 'weekly' || it.done || bySeries.has(it.seriesId)) continue;
    const at = new Date(new Date(it.start).getTime() - leadMinutes * 60000);
    const day = (at.getDay() + 6) % 7;
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    bySeries.set(it.seriesId, { key: `${it.seriesId}|${day}|${time}|${it.name}`, seriesId: it.seriesId, day, time, name: it.name });
  }
  return [...bySeries.values()].sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
}

/** Runs the Shortcut with one line per alarm: "weekday (1 = Monday)|HH:mm|label". */
export function shortcutUrl(alarms) {
  const lines = alarms.map((a) => `${a.day + 1}|${a.time}|BUN: ${a.name.replace(/[|\r\n]+/g, ' ').slice(0, 40)}`);
  return `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}&input=text&text=${encodeURIComponent(lines.join('\n'))}`;
}
