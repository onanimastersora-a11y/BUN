// Date helpers shared by the backend, the main window and the pet window.
// All "day keys" are local dates formatted YYYY-MM-DD.

export const HOUR = 60 * 60 * 1000;
export const MINUTE = 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

export function dayKey(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Monday 00:00 of the week containing `date`.
export function startOfWeek(date = new Date()) {
  const d = startOfDay(date);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

const zones = new Map();
// dayKey / addDays for a named time zone: the cloud runs in UTC, its users don't.
export function zoneOf(timeZone) {
  if (zones.has(timeZone)) return zones.get(timeZone);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = (d) => Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const offset = (d) => {
    const p = parts(d);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000;
  };
  const zone = {
    dayKey(date) {
      const p = parts(new Date(date));
      return `${p.year}-${p.month}-${p.day}`;
    },
    // The same wall-clock time `n` days later.
    addDays(date, n) {
      const from = new Date(date);
      const to = new Date(from.getTime() + n * 24 * HOUR);
      return new Date(to.getTime() + offset(from) - offset(to));
    },
  };
  zones.set(timeZone, zone);
  return zone;
}

export function sameDay(a, b) {
  return dayKey(a) === dayKey(b);
}

export function fmtTime(date) {
  const d = new Date(date);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDate(date, lang = 'vi') {
  const d = new Date(date);
  return lang === 'vi' ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, ${d.getFullYear()}`;
}

export function fmtDayMonth(date, lang = 'vi') {
  const d = new Date(date);
  return lang === 'vi' ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}` : `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
}

export function fmtRange(start, end, lang = 'vi') {
  if (!start) return '';
  const s = new Date(start);
  const e = end ? new Date(end) : null;
  const base = `${fmtDayMonth(s, lang)} · ${fmtTime(s)}`;
  if (!e) return base;
  return sameDay(s, e) ? `${base}–${fmtTime(e)}` : `${base} → ${fmtDayMonth(e, lang)} ${fmtTime(e)}`;
}

// "HH:MM" on a given day -> Date
export function atTime(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = startOfDay(day);
  d.setHours(h, m || 0, 0, 0);
  return d;
}

export function toInputDate(date) {
  return dayKey(date);
}

export function toInputTime(date) {
  return fmtTime(date);
}

// A checklist deadline: "05/11 · 17:00".
export function fmtDue(due, lang = 'vi') {
  return due ? fmtRange(due, null, lang) : '';
}
