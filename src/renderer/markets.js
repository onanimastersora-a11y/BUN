// Weather and market data for the home screen's daily board.
//
// Sources (all free, no key):
//   weather + city search  Open-Meteo
//   stocks, indices, FX, crypto, world gold  Yahoo Finance chart/search
//   Vietnamese gold (SJC)  PNJ's public price feed
// Yahoo sends no CORS headers, so the desktop app reads it through the main
// process and the web app through the site's /api/yahoo proxy.

import { bridge } from './api.js';

const YAHOO = 'https://query1.finance.yahoo.com';
const CACHE_KEY = 'bun-market-cache';
const TTL = 5 * 60 * 1000;

async function getJson(url) {
  if (bridge.isElectron) return bridge.invoke('net:json', url);
  const target = url.startsWith(YAHOO) ? url.replace(`${YAHOO}/v8/finance/chart/`, '/api/yahoo/chart/').replace(`${YAHOO}/v1/finance/search`, '/api/yahoo/search') : url;
  const res = await fetch(target);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Small localStorage cache so the board shows the last values offline.
function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
  } catch {
    return {};
  }
}
function writeCache(key, data) {
  try {
    const all = readCache();
    all[key] = { data, at: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {}
}
export function cached(key) {
  return readCache()[key] || null;
}

async function withCache(key, load, force) {
  const hit = cached(key);
  if (!force && hit && Date.now() - hit.at < TTL) return { ...hit.data, at: hit.at, stale: false };
  try {
    const data = await load();
    writeCache(key, data);
    return { ...data, at: Date.now(), stale: false };
  } catch (err) {
    if (hit) return { ...hit.data, at: hit.at, stale: true };
    throw err;
  }
}

// ---------- weather ----------

// WMO weather codes -> [emoji, vi, en]
const WEATHER = [
  [[0], '☀️', 'Trời quang', 'Clear sky'],
  [[1, 2], '🌤️', 'Ít mây', 'Partly cloudy'],
  [[3], '☁️', 'Nhiều mây', 'Cloudy'],
  [[45, 48], '🌫️', 'Sương mù', 'Fog'],
  [[51, 53, 55, 56, 57], '🌦️', 'Mưa phùn', 'Drizzle'],
  [[61, 63, 65, 66, 67, 80, 81, 82], '🌧️', 'Có mưa', 'Rain'],
  [[71, 73, 75, 77, 85, 86], '🌨️', 'Có tuyết', 'Snow'],
  [[95, 96, 99], '⛈️', 'Dông', 'Thunderstorm'],
];

export function describeWeather(code, lang) {
  const row = WEATHER.find(([codes]) => codes.includes(code)) || WEATHER[2];
  return { icon: row[1], text: lang === 'en' ? row[3] : row[2] };
}

export function getWeather({ lat, lon }, force) {
  return withCache(`weather:${lat.toFixed(2)},${lon.toFixed(2)}`, async () => {
    const d = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`,
    );
    return {
      temp: d.current.temperature_2m,
      code: d.current.weather_code,
      max: d.daily.temperature_2m_max[0],
      min: d.daily.temperature_2m_min[0],
      rain: d.daily.precipitation_probability_max?.[0] ?? null,
    };
  }, force);
}

export async function searchCity(q, lang) {
  if (!q.trim()) return [];
  const d = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=${lang === 'en' ? 'en' : 'vi'}`);
  return (d.results || []).map((r) => ({ name: r.name, detail: [r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude }));
}

// ---------- quotes ----------

async function yahooQuote(symbol) {
  const d = await getJson(`${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=15m`);
  const m = d.chart?.result?.[0]?.meta;
  if (!m || m.regularMarketPrice == null) throw new Error('no data');
  const prev = m.chartPreviousClose ?? m.previousClose;
  return {
    price: m.regularMarketPrice,
    change: prev != null ? m.regularMarketPrice - prev : null,
    changePct: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : null,
    currency: m.currency,
    type: m.instrumentType,
    name: m.shortName || m.longName || symbol,
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
  };
}

async function sjcQuote() {
  const d = await getJson('https://edge-api.pnj.io/ecom-frontend/v1/get-gold-price?zone=00');
  const row = (d.data || []).find((r) => r.masp === 'SJC');
  if (!row) throw new Error('no data');
  // PNJ quotes thousand đồng per chỉ; show million đồng per lượng (10 chỉ).
  return { price: row.giaban / 100, buy: row.giamua / 100, currency: 'trVND', name: 'Vàng SJC', time: null };
}

export function getQuote(item, force) {
  return withCache(`quote:${item.kind}:${item.symbol}`, () => (item.kind === 'gold' ? sjcQuote() : yahooQuote(item.symbol)), force);
}

// Suggestions while the user types a ticker / coin / index.
export async function searchSymbols(q) {
  const query = q.trim();
  if (!query) return [];
  const out = [];
  if (/^(sjc|vàng|vang|gold)/i.test(query)) {
    out.push({ kind: 'gold', symbol: 'SJC', label: 'Vàng SJC', detail: 'PNJ · triệu đ/lượng' });
    out.push({ kind: 'yahoo', symbol: 'GC=F', label: 'Vàng thế giới', detail: 'COMEX · USD/oz' });
  }
  try {
    const d = await getJson(`${YAHOO}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`);
    for (const r of d.quotes || []) {
      if (!r.symbol) continue;
      out.push({ kind: 'yahoo', symbol: r.symbol, label: r.symbol.replace(/\.VN$/, '').replace(/-USD$/, ''), detail: [r.shortname || r.longname, r.exchDisp || r.typeDisp].filter(Boolean).join(' · ') });
    }
  } catch {}
  return out;
}

// ---------- formatting ----------

export function formatPrice(q, lang) {
  const loc = lang === 'en' ? 'en-US' : 'vi-VN';
  if (q.currency === 'trVND') return `${q.price.toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 2 })} tr`;
  // Indices keep two decimals (VN-Index 1.755,61); big prices like 61.500 đ don't need any.
  const digits = q.type === 'INDEX' ? 2 : q.price >= 1000 ? 0 : q.price >= 1 ? 2 : 4;
  const n = q.price.toLocaleString(loc, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (q.currency === 'USD') return `$${n}`;
  return n;
}

export function formatChange(q, lang) {
  if (q.changePct == null) return null;
  const loc = lang === 'en' ? 'en-US' : 'vi-VN';
  const sign = q.changePct > 0 ? '+' : '';
  return `${sign}${q.changePct.toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}
