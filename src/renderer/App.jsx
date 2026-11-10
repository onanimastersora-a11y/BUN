import { useCallback, useEffect, useState } from 'react';
import { api, bridge } from './api.js';
import { useBun, useCloud, useIsMobile, useUpdate } from './store.jsx';
import { errorText } from './i18n.js';
import { Modal } from './components/Popover.jsx';
import Tour, { TOUR_KEY } from './components/Tour.jsx';
import Greeting from './components/Greeting.jsx';
import { Icon } from './icons.jsx';
import Onboarding from './views/Onboarding.jsx';
import Home from './views/Home.jsx';
import CalendarView from './views/CalendarView.jsx';
import BoardView from './views/BoardView.jsx';
import Sidebar from './views/Sidebar.jsx';
import Settings from './views/Settings.jsx';
import Pet from './pet/Pet.jsx';
import { unlockAudioOnFirstTap } from './ringtone.js';
import { isIOS, isStandalone, startPushSync } from './push.js';
import { dayKey } from '../core/time.js';
import './pet/pet.css';

const PENDING_LINK = 'bun-pending-link';
const INSTALL_HINT_KEY = 'bun-install-hint';

function parseBoardLink(url) {
  const m = /^bun:\/\/board\/([a-z0-9]+)/i.exec(url || '');
  return m ? m[1] : null;
}

export default function App() {
  const { session, user, t, toast, route, navigate } = useBun();
  const mobile = useIsMobile();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [petHidden, setPetHidden] = useState(false);
  const [touring, setTouring] = useState(false);

  // A new account starts with the guide.
  useEffect(() => {
    if (session && localStorage.getItem(TOUR_KEY)) setTouring(true);
  }, [!!session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Share links: join the board right away, or after onboarding if signed out.
  const openLink = useCallback(
    async (url) => {
      const boardId = parseBoardLink(url);
      if (!boardId) return;
      if (!session) {
        localStorage.setItem(PENDING_LINK, url);
        return;
      }
      localStorage.removeItem(PENDING_LINK);
      bridge.send('app:linkHandled');
      try {
        const board = await api.joinBoard(boardId);
        toast(t('board.joined', { name: board.name }));
        navigate({ view: 'board', boardId, enter: 'zoom' });
      } catch {
        toast(t('board.notFound'), 'error');
      }
    },
    [session, toast, t, navigate],
  );

  useEffect(() => {
    if (session === undefined) return;
    bridge.invoke('app:takeLink').then((url) => url && openLink(url));
    // Web: /app/?link=bun://board/<id>
    const fromQuery = new URLSearchParams(location.search).get('link');
    if (fromQuery) {
      history.replaceState(null, '', location.pathname);
      openLink(fromQuery);
    }
    const pending = localStorage.getItem(PENDING_LINK);
    if (session && pending) openLink(pending);
    const offLink = bridge.on('bun:link', openLink);
    const offNav = bridge.on('bun:navigate', (r) => navigate({ ...r, enter: 'zoom' }));
    return () => {
      offLink();
      offNav();
    };
  }, [session, openLink, navigate]);

  if (session === undefined) return <div className="boot" />;
  if (!session) return <Onboarding />;

  const titles = { home: t('nav.home'), calendar: t('cal.title'), board: t('home.checklist'), friends: t('fr.title') };
  const views = (
    <div key={`${route.view}:${route.boardId || ''}`} className={`view view--${route.enter || 'fade'}`} style={route.origin ? { transformOrigin: `${route.origin.x}px ${route.origin.y}px` } : undefined}>
      {route.view === 'home' && <Home />}
      {route.view === 'calendar' && <CalendarView initialDate={route.date} />}
      {route.view === 'board' && <BoardView boardId={route.boardId} />}
      {route.view === 'friends' && <Sidebar mobile />}
    </div>
  );
  const settings = settingsOpen && <Settings onClose={() => setSettingsOpen(false)} onShowPet={() => setPetHidden(false)} onReplayTour={() => setTouring(true)} user={user} />;
  const tour = touring && <Tour onDone={() => setTouring(false)} />;
  const webPet = !bridge.isElectron && (
    <>
      <WebRuntime />
      <Pet embedded hidden={petHidden} onHide={() => setPetHidden(true)} />
    </>
  );

  if (mobile) {
    const tabs = [
      ['home', 'home', t('nav.home')],
      ['calendar', 'calendar', t('cal.title')],
      ['board', 'list', t('home.checklist')],
      ['friends', 'users', t('fr.title')],
    ];
    return (
      <div className="mobile">
        <InstallHint />
        <header className="mobile__top">
          <span className="mobile__title">{route.view === 'home' ? 'BUN' : titles[route.view]}</span>
          <button className="icon-btn" onClick={() => setSettingsOpen(true)} title={t('nav.settings')}>
            <Icon name="settings" size={20} />
          </button>
        </header>
        <div className="content mobile__content">{views}</div>
        <nav className="tabbar">
          {tabs.map(([view, icon, label]) => (
            <button
              key={view}
              className={`tabbar__tab ${route.view === view ? 'is-on' : ''}`}
              onClick={async () => {
                if (view !== 'board') return navigate({ view, enter: 'fade' });
                // Last opened board, or the first one if it was deleted.
                const boards = await api.listBoards();
                const board = boards.find((b) => b.id === session.settings.lastBoardId) || boards[0];
                navigate({ view, boardId: board?.id, enter: 'fade' });
              }}
            >
              <Icon name={icon} size={21} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {webPet}
        {settings}
        <LinkPrompt />
        <Greeting />
        {tour}
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <header className="topbar">
          {route.view !== 'home' ? (
            <button className="topbar__back" onClick={() => navigate({ view: 'home', enter: 'back' })}>
              <Icon name="arrowLeft" size={17} />
              <span>{t('nav.home')}</span>
            </button>
          ) : null}
          {route.view !== 'home' && <span className="topbar__title">{titles[route.view]}</span>}
          <span className="topbar__spacer" />
          <button className="topbar__btn" onClick={() => setSettingsOpen(true)} title={t('nav.settings')}>
            <Icon name="settings" size={18} />
          </button>
        </header>
        <div className="content">{views}</div>
      </main>
      {webPet}
      {settings}
      <LinkPrompt />
      <UpdateBanner />
      <Greeting />
      {tour}
    </div>
  );
}

// Accounts made on one device only (before the cloud, or offline): enter the
// code once to put the account and its boards/tasks/notes on the server, so
// it works on every device.
function LinkPrompt() {
  const { t, user, toast } = useBun();
  const cloud = useCloud();
  const [later, setLater] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!cloud?.needsLink || cloud.autoLinking || later) return null;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.linkAccount(code);
      toast(t('cloud.linked'));
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => setLater(true)} className="link-modal">
      <form className="link-modal__body" onSubmit={submit}>
        <h2>{t('cloud.linkTitle')}</h2>
        <p className="muted">{t('cloud.linkText', { name: user.handle })}</p>
        <label className="label" htmlFor="link-code">
          {t('ob.code')}
        </label>
        <input id="link-code" className="input" type="password" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
        {error && <p className="onboard__error">{error}</p>}
        <div className="link-modal__foot">
          <button type="button" className="btn btn--ghost" onClick={() => setLater(true)}>
            {t('cloud.later')}
          </button>
          <button className="btn btn--primary" disabled={code.length < 4 || busy}>
            {t('cloud.linkBtn')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Web / iPhone only: what the Electron main process does on the desktop —
// the reminder loop, yesterday's-note recap, push sync and the iOS audio unlock.
function WebRuntime() {
  useEffect(() => {
    unlockAudioOnFirstTap();
    startPushSync();
    let lastDay = null;
    const tick = async () => {
      try {
        const today = dayKey();
        if (today !== lastDay) {
          lastDay = today;
          const recap = await api.takeDailyRecap(today);
          if (recap) bridge.emit('pet:alert', { kind: 'recap', ...recap });
        }
        for (const task of await api.takeDueReminders()) {
          bridge.emit('pet:alert', { kind: 'task', task });
          // A system notification too when the tab is in the background (desktop browsers).
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            navigator.serviceWorker?.ready.then((reg) => reg.showNotification('BUN 🐾', { body: task.name, tag: task.id })).catch(() => {});
          }
        }
      } catch {}
    };
    const first = setTimeout(tick, 1500);
    const id = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return null;
}

// Desktop: a new version has downloaded.
function UpdateBanner() {
  const { t } = useBun();
  const update = useUpdate();
  const [closed, setClosed] = useState(false);
  if (update?.state !== 'ready' || closed) return null;
  return (
    <div className="update-banner">
      <Icon name="refresh" size={16} />
      <span>{t('update.banner', { v: update.version })}</span>
      <button className="btn btn--sm btn--primary" onClick={() => bridge.send('app:installUpdate')}>
        {t('update.install')}
      </button>
      <button className="icon-btn icon-btn--sm" onClick={() => setClosed(true)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

// iPhone Safari (not yet on the Home Screen): how to install BUN.
function InstallHint() {
  const { t } = useBun();
  const [show, setShow] = useState(() => {
    try {
      return isIOS() && !isStandalone() && !localStorage.getItem(INSTALL_HINT_KEY);
    } catch {
      return false;
    }
  });
  if (!show) return null;
  return (
    <div className="install-hint">
      <span className="install-hint__icon">
        <Icon name="upload" size={16} />
      </span>
      <span>{t('install.hint')}</span>
      <button
        className="icon-btn icon-btn--sm"
        onClick={() => {
          setShow(false);
          try {
            localStorage.setItem(INSTALL_HINT_KEY, '1');
          } catch {}
        }}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
