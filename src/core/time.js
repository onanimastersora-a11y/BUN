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
