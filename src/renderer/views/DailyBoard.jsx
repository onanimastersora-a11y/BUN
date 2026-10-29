// "Today" board on the home screen: how busy the day is, today's tasks,
// the weather and the user's watchlist (VN-Index, gold, USD/VND by default;
// any stock, coin, index or currency can be added).

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, bridge } from '../api.js';
import { useBun } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { Popover } from '../components/Popover.jsx';
import { describeWeather, formatChange, formatPrice, getQuote, getWeather, searchCity, searchSymbols } from '../markets.js';
import { fmtTime, sameDay } from '../../core/time.js';

const REFRESH = 5 * 60 * 1000;

function dayMood(n) {
  if (n === 0) return { key: 'free', icon: '🌿' };
  if (n <= 2) return { key: 'light', icon: '🍃' };
  if (n <= 4) return { key: 'lively', icon: '⚡' };
  if (n <= 6) return { key: 'busy', icon: '🔥' };
  return { key: 'packed', icon: '🚀' };
}

export default function DailyBoard({ items, now }) {
  const { t, lang, settings, run } = useBun();
  const today = items.filter((i) => sameDay(i.start, now)).sort((a, b) => a.start.localeCompare(b.start));
  const mood = dayMood(today.length);
  const [weather, setWeather] = useState(null);
  const [quotes, setQuotes] = useState({});
  const [updated, setUpdated] = useState(null);
  const [adding, setAdding] = useState(null);
  const [cityPop, setCityPop] = useState(null);
  const [spinning, setSpinning] = useState(false);
  const watch = settings.watchlist || [];
  const place = settings.weather;

  const refresh = useCallback(
    async (force = false) => {
      setSpinning(true);
      const tasks = [
        getWeather(place, force)
          .then(setWeather)
          .catch(() => setWeather((w) => w || { error: true })),
        ...watch.map((item) =>
          getQuote(item, force)
            .then((q) => setQuotes((all) => ({ ...all, [item.id]: q })))
            .catch(() => setQuotes((all) => ({ ...all, [item.id]: all[item.id] || { error: true } }))),
        ),
      ];
      await Promise.allSettled(tasks);
      setUpdated(new Date());
      setSpinning(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [place?.lat, place?.lon, watch.map((w) => w.id).join(',')],
  );

  useEffect(() => {
    refresh();
    const id = setInterval(() => refresh(), REFRESH);
    const onOnline = () => refresh(true);
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(id);
      window.removeEventListener('online', onOnline);
    };
  }, [refresh]);

  const removeItem = (id) => run(api.updateSettings({ watchlist: watch.filter((w) => w.id !== id) }));
  const addItem = (item) => {
    setAdding(null);
    if (watch.some((w) => w.kind === item.kind && w.symbol === item.symbol)) return;
    run(api.updateSettings({ watchlist: [...watch, { ...item, id: `${item.kind}:${item.symbol}` }] }));
  };

  const wx = weather && !weather.error ? describeWeather(weather.code, lang) : null;

  return (
    <section className="daily card">
      <div className="daily__today">
        <div className="daily__mood">
          <span className="daily__mood-icon">{mood.icon}</span>
          <div>
            <div className="daily__kicker">{t('daily.title')}</div>
            <h3 className="daily__headline">{t('daily.headline', { mood: t(`daily.mood.${mood.key}`) })}</h3>
          </div>
        </div>
        {today.length === 0 ? (
          <p className="daily__empty">{t('daily.none')}</p>
        ) : (
          <>
            <p className="daily__sub">{today.length === 1 ? t('daily.withOne') : t('daily.withN', { n: today.length })}</p>
            <ul className="daily__tasks">
              {today.slice(0, 4).map((it) => (
                <li key={it.id} className={it.done ? 'is-done' : ''}>
                  <span className="daily__time">{fmtTime(it.start)}</span>
                  <span className="daily__name">{it.name}</span>
                  {it.role && <span className="chip">{it.role}</span>}
                </li>
              ))}
            </ul>
            {today.length > 4 && <div className="daily__more">{t('home.moreItems', { n: today.length - 4 })}</div>}
          </>
        )}
      </div>

      <div className="daily__weather">
        <button className="daily__city" onClick={(e) => setCityPop(e.currentTarget.getBoundingClientRect())} data-popover-keep>
          <Icon name="pin" size={14} /> {place?.name} <Icon name="chevronDown" size={13} />
        </button>
        {wx ? (
          <>
            <div className="daily__temp">
              <span className="daily__wx-icon">{wx.icon}</span>
              {Math.round(weather.temp)}°
            </div>
            <div className="daily__wx-text">{wx.text}</div>
            <div className="daily__wx-range">
              {Math.round(weather.min)}° – {Math.round(weather.max)}°{weather.rain != null && ` · 💧 ${weather.rain}%`}
            </div>
          </>
        ) : (
          <div className="daily__wx-text faint">{weather?.error ? t('daily.offline') : '…'}</div>
        )}
      </div>

      <div className="daily__market">
        <div className="daily__market-head">
          <span className="daily__kicker">{t('daily.market')}</span>
          <span className="faint small">{updated && `${t('daily.updated')} ${fmtTime(updated)}`}</span>
          <button className={`icon-btn icon-btn--sm ${spinning ? 'is-spinning' : ''}`} onClick={() => refresh(true)} title={t('daily.refresh')}>
            <Icon name="refresh" size={15} />
          </button>
        </div>
        <div className="tiles">
          {watch.map((item) => {
            const q = quotes[item.id];
            const ch = q && !q.error ? formatChange(q, lang) : null;
            return (
              <div key={item.id} className={`tile ${q?.stale ? 'is-stale' : ''}`} title={q?.name || item.symbol}>
                <button className="tile__remove" onClick={() => removeItem(item.id)} title={t('task.delete')}>
                  <Icon name="x" size={12} />
                </button>
                <div className="tile__label">{item.label}</div>
                <div className="tile__price">{q && !q.error ? formatPrice(q, lang) : q?.error ? '—' : '…'}</div>
                {item.kind === 'gold' && q && !q.error ? (
                  <div className="tile__change faint">
                    {t('daily.buy')} {formatPrice({ ...q, price: q.buy }, lang)}
                  </div>
                ) : (
                  ch && <div className={`tile__change ${q.changePct >= 0 ? 'is-up' : 'is-down'}`}>{ch}</div>
                )}
              </div>
            );
          })}
          <button className="tile tile--add" onClick={(e) => setAdding(e.currentTarget.getBoundingClientRect())} data-popover-keep>
            <Icon name="plus" size={18} />
            <span>{t('daily.add')}</span>
          </button>
        </div>
      </div>

      {adding && <SymbolPicker anchor={adding} onPick={addItem} onClose={() => setAdding(null)} />}
      {cityPop && <CityPicker anchor={cityPop} onClose={() => setCityPop(null)} />}
    </section>
  );
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function SymbolPicker({ anchor, onPick, onClose }) {
  const { t } = useBun();
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const query = useDebounced(q, 350);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    if (!query.trim()) return setResults([]);
    setLoading(true);
    searchSymbols(query).then((r) => {
      if (n !== seq.current) return;
      setResults(r);
      setLoading(false);
    });
  }, [query]);

  return (
    <Popover anchor={anchor} onClose={onClose} className="picker-pop">
      <span className="label">{t('daily.addTitle')}</span>
      <input className="input input--sm" autoFocus value={q} placeholder={t('daily.addPh')} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-list">
        {loading && <div className="faint small picker-note">…</div>}
        {!loading && query && results.length === 0 && <div className="faint small picker-note">{t('daily.noResult')}</div>}
        {results.map((r) => (
          <button key={`${r.kind}:${r.symbol}`} className="picker-item" onClick={() => onPick({ kind: r.kind, symbol: r.symbol, label: r.label })}>
            <b>{r.label}</b>
            <span className="faint small">{r.detail || r.symbol}</span>
          </button>
        ))}
        {!query && <div className="faint small picker-note">{t('daily.addHint')}</div>}
      </div>
    </Popover>
  );
}

function CityPicker({ anchor, onClose }) {
  const { t, lang, run } = useBun();
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const query = useDebounced(q, 350);

  useEffect(() => {
    if (!query.trim()) return setResults([]);
    searchCity(query, lang).then(setResults).catch(() => setResults([]));
  }, [query, lang]);

  const choose = (place) => {
    run(api.updateSettings({ weather: { name: place.name, lat: place.lat, lon: place.lon } }));
    onClose();
  };

  const locate = () =>
    navigator.geolocation?.getCurrentPosition(
      (p) => choose({ name: t('daily.here'), lat: p.coords.latitude, lon: p.coords.longitude }),
      () => {},
      { timeout: 8000 },
    );

  return (
    <Popover anchor={anchor} onClose={onClose} className="picker-pop">
      <span className="label">{t('daily.city')}</span>
      <input className="input input--sm" autoFocus value={q} placeholder={t('daily.cityPh')} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-list">
        {!bridge.isElectron && navigator.geolocation && (
          <button className="picker-item" onClick={locate}>
            <b>📍 {t('daily.useLocation')}</b>
          </button>
        )}
        {results.map((r) => (
          <button key={`${r.lat},${r.lon}`} className="picker-item" onClick={() => choose(r)}>
            <b>{r.name}</b>
            <span className="faint small">{r.detail}</span>
          </button>
        ))}
      </div>
    </Popover>
  );
}
