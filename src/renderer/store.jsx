import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, bridge } from './api.js';
import { makeT, errorText } from './i18n.js';

const Ctx = createContext(null);

export function BunProvider({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading, null = signed out
  const [toasts, setToasts] = useState([]);
  const [route, setRoute] = useState({ view: 'home' });

  const loadSession = useCallback(async () => setSession(await api.getSession()), []);

  useEffect(() => {
    loadSession();
    return bridge.on('bun:changed', (topics) => {
      if (topics.includes('session') || topics.includes('settings')) loadSession();
    });
  }, [loadSession]);

  const settings = session?.settings;
  const lang = settings?.language || (typeof localStorage !== 'undefined' && localStorage.getItem('bun-lang')) || 'vi';
  const theme = settings?.theme || 'light';
  const t = useMemo(() => makeT(lang), [lang]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = lang;
  }, [theme, lang]);

  const toast = useCallback((text, kind = 'info') => {
    const id = Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 2600);
  }, []);

  // Run an API call; show a friendly toast if it fails.
  const run = useCallback(
    async (promise) => {
      try {
        return await promise;
      } catch (err) {
        toast(errorText(t, err), 'error');
        throw err;
      }
    },
    [t, toast],
  );

  const navigate = useCallback((next) => setRoute(next), []);

  const value = useMemo(
    () => ({ session, user: session?.user, settings, lang, theme, t, toast, run, route, navigate, reloadSession: loadSession }),
    [session, settings, lang, theme, t, toast, run, route, navigate, loadSession],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind === 'error' ? 'toast--error' : ''}`}>
            {x.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useBun = () => useContext(Ctx);

// Fetch data and refetch whenever the backend reports a change to one of `topics`.
export function useLive(fetcher, deps, topics = []) {
  const [data, setData] = useState(undefined);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const topicKey = topics.join(',');

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.resolve(fetchRef.current())
        .then((d) => alive && setData(d))
        .catch(() => alive && setData(null));
    load();
    const off = bridge.on('bun:changed', (changed) => {
      if (changed.some((c) => topicKey.split(',').includes(c))) load();
    });
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, topicKey]);

  return data;
}

// Current time, re-rendered every `ms`.
export function useNow(ms = 30000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

// True on phone-sized screens (portrait web / iPhone app).
const MOBILE_QUERY = '(max-width: 760px)';
export function useIsMobile() {
  const [mobile, setMobile] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(MOBILE_QUERY);
    const on = () => setMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}
