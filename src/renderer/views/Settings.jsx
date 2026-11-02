import { useEffect, useRef, useState } from 'react';
import { api, bridge } from '../api.js';
import { useBun, useCloud, useLive, useUpdate } from '../store.jsx';
import { fmtTime } from '../../core/time.js';
import { Icon } from '../icons.jsx';
import { PetAvatar } from '../sprite.jsx';
import { Modal } from '../components/Popover.jsx';
import { BUILTIN_TONES, importToneFile, isSoundCloudUrl, playRingtone } from '../ringtone.js';
import { disablePush, enablePush, isIOS, isStandalone, pushEnabled, pushSupported, testPush } from '../push.js';
import { SHORTCUT_NAME, loadAlarmState, saveAlarmState, shortcutUrl, weeklyAlarms } from '../alarm.js';
import { ALARM_SHORTCUT_URL, CLOUD_URL } from '../../core/config.js';

const LEADS = [1, 5, 10, 15, 30];

export default function Settings({ onClose, onShowPet }) {
  const { user, settings, t, run, toast } = useBun();
  const [custom, setCustom] = useState(LEADS.includes(settings.leadMinutes) ? '' : String(settings.leadMinutes));
  const set = (patch) => run(api.updateSettings(patch));

  return (
    <Modal onClose={onClose} className="settings">
      <div className="settings__head">
        <h2>{t('set.title')}</h2>
        <button className="icon-btn" onClick={onClose} title={t('set.close')}>
          <Icon name="x" />
        </button>
      </div>

      <section className="settings__section">
        <div className="settings__row settings__row--stack">
          <div>
            <div className="settings__name">
              <Icon name="bell" size={16} /> {t('set.notify')}
            </div>
            <div className="faint small">{t('set.notifyHint')}</div>
          </div>
          <div className="settings__leads">
            <div className="segmented segmented--wrap">
              {LEADS.map((n) => (
                <button
                  key={n}
                  className={settings.leadMinutes === n && !custom ? 'is-on' : ''}
                  onClick={() => {
                    setCustom('');
                    set({ leadMinutes: n });
                  }}
                >
                  {t('set.minutes', { n })}
                </button>
              ))}
            </div>
            <label className="settings__custom">
              <span className="faint small">{t('set.custom')}</span>
              <input
                className="input input--sm"
                type="number"
                min={1}
                max={240}
                value={custom}
                placeholder="—"
                onChange={(e) => {
                  setCustom(e.target.value);
                  const n = Number(e.target.value);
                  if (n >= 1 && n <= 240) set({ leadMinutes: n });
                }}
              />
            </label>
          </div>
        </div>
        <RingtoneSettings />
        {!bridge.isElectron && <PhoneNotifications />}
        {!bridge.isElectron && isIOS() && <IphoneAlarms />}
      </section>

      <section className="settings__section">
        <div className="settings__row">
          <div className="settings__name">
            <Icon name="globe" size={16} /> {t('set.language')}
          </div>
          <div className="segmented">
            <button className={settings.language === 'vi' ? 'is-on' : ''} onClick={() => set({ language: 'vi' })}>
              Tiếng Việt
            </button>
            <button className={settings.language === 'en' ? 'is-on' : ''} onClick={() => set({ language: 'en' })}>
              English
            </button>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__name">
            <Icon name={settings.theme === 'dark' ? 'moon' : 'sun'} size={16} /> {t('set.theme')}
          </div>
          <div className="segmented">
            <button className={settings.theme === 'light' ? 'is-on' : ''} onClick={() => set({ theme: 'light' })}>
              <Icon name="sun" size={14} /> {t('set.light')}
            </button>
            <button className={settings.theme === 'dark' ? 'is-on' : ''} onClick={() => set({ theme: 'dark' })}>
              <Icon name="moon" size={14} /> {t('set.dark')}
            </button>
          </div>
        </div>
      </section>

      <section className="settings__section">
        <div className="settings__row">
          <div className="settings__name">
            <Icon name="swap" size={16} /> {t('set.myPet')}
          </div>
          <div className="segmented segmented--pets">
            {['cat', 'dog'].map((a) => (
              <button key={a} className={user.animal === a ? 'is-on' : ''} onClick={() => user.animal !== a && run(api.updateProfile({ animal: a })).then(() => toast(t('set.petChanged')))}>
                <PetAvatar animal={a} size={22} /> {t(`set.${a}`)}
              </button>
            ))}
          </div>
        </div>
        {bridge.isElectron && (
          <div className="settings__row">
            <div className="settings__name">
              <Icon name="paw" size={16} /> {t('set.petSize')}
            </div>
            <div className="segmented">
              {[
                [2, 'set.small'],
                [3, 'set.medium'],
                [4, 'set.large'],
              ].map(([n, key]) => (
                <button key={n} className={settings.petScale === n ? 'is-on' : ''} onClick={() => set({ petScale: n })}>
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        )}
        {bridge.isElectron && (
          <div className="settings__row">
            <div className="settings__name">{t('set.autostart')}</div>
            <button className={`switch ${settings.autostart ? 'is-on' : ''}`} onClick={() => set({ autostart: !settings.autostart })} />
          </div>
        )}
        <div className="settings__row">
          <div className="settings__name">{t('set.showPet')}</div>
          <button
            className="btn btn--sm"
            onClick={() => {
              if (bridge.isElectron) bridge.send('app:showPet');
              else onShowPet?.();
              onClose();
            }}
          >
            <PetAvatar animal={user.animal} size={22} /> {user.name}
          </button>
        </div>
      </section>

      {bridge.isElectron && (
        <section className="settings__section">
          <AppUpdate />
        </section>
      )}

      <section className="settings__section settings__account">
        <PetAvatar animal={user.animal} size={44} />
        <div className="settings__who">
          <b>{user.name}</b>
          <span className="faint">{user.handle}</span>
          <SyncStatus />
        </div>
        <button
          className="btn btn--sm btn--danger"
          onClick={async () => {
            onClose();
            await api.logout();
          }}
        >
          <Icon name="logout" size={15} /> {t('set.logout')}
        </button>
      </section>
    </Modal>
  );
}

function RingtoneSettings() {
  const { settings, t, lang, run, toast } = useBun();
  const tone = settings.ringtone || {};
  const [kind, setKind] = useState(tone.kind || 'builtin');
  const [url, setUrl] = useState(tone.url || '');
  const [playing, setPlaying] = useState(false);
  const player = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => () => player.current?.stop(), []);

  const save = (patch) => run(api.updateSettings({ ringtone: { ...tone, ...patch } }));

  const preview = (override) => {
    player.current?.stop();
    if (playing && !override) {
      setPlaying(false);
      return;
    }
    player.current = playRingtone({ ...tone, ...override }, { loop: false, maxMs: 12000 });
    setPlaying(true);
    setTimeout(() => setPlaying(false), 12000);
  };

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const saved = await importToneFile(file);
      await save(saved);
      toast(t('ring.fileSaved', { name: file.name }));
    } catch {
      toast(t('ring.fileError'), 'error');
    }
  };

  return (
    <div className="settings__row settings__row--stack">
      <div>
        <div className="settings__name">
          <Icon name="music" size={16} /> {t('ring.title')}
        </div>
        <div className="faint small">{t('ring.hint')}</div>
      </div>
      <div className="segmented segmented--wrap">
        {['builtin', 'soundcloud', 'file'].map((k) => (
          <button key={k} className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>
            {t(`ring.${k}`)}
          </button>
        ))}
      </div>

      {kind === 'builtin' && (
        <div className="tones">
          {BUILTIN_TONES.map((b) => (
            <div key={b.id} className={`tone ${tone.kind === 'builtin' && tone.id === b.id ? 'is-on' : ''}`}>
              <button className="tone__pick" onClick={() => save({ kind: 'builtin', id: b.id })}>
                <span className="tone__radio" />
                {lang === 'en' ? b.en : b.vi}
              </button>
              <button className="icon-btn icon-btn--sm" title={t('ring.preview')} onClick={() => preview({ kind: 'builtin', id: b.id })}>
                <Icon name="play" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {kind === 'soundcloud' && (
        <div className="ring-link">
          <input className="input input--sm" value={url} placeholder="https://soundcloud.com/…" onChange={(e) => setUrl(e.target.value)} />
          <button className="btn btn--sm btn--primary" disabled={!isSoundCloudUrl(url)} onClick={() => save({ kind: 'soundcloud', url: url.trim() }).then(() => toast(t('ring.saved')))}>
            {t('task.save')}
          </button>
          <p className="faint small">{t('ring.soundcloudHint')}</p>
        </div>
      )}

      {kind === 'file' && (
        <div className="ring-link">
          <input ref={fileRef} type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.aac" hidden onChange={pickFile} />
          <button className="btn btn--sm" onClick={() => fileRef.current.click()}>
            <Icon name="upload" size={14} /> {t('ring.pickFile')}
          </button>
          {tone.kind === 'file' && tone.fileName && <span className="chip chip--blue">{tone.fileName}</span>}
          <p className="faint small">{t('ring.fileHint')}</p>
        </div>
      )}

      <div className="ring-foot">
        <span className="faint small">{t('ring.volume')}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={tone.volume ?? 0.8}
          onChange={(e) => save({ volume: Number(e.target.value) })}
          className="range"
        />
        <button className="btn btn--sm" onClick={() => preview()}>
          <Icon name={playing ? 'stop' : 'play'} size={13} /> {playing ? t('ring.stop') : t('ring.test')}
        </button>
      </div>
    </div>
  );
}

function SyncStatus() {
  const { t } = useBun();
  const cloud = useCloud();
  const [busy, setBusy] = useState(false);
  if (!cloud) return null;
  const label = !cloud.linked
    ? t('cloud.notLinked')
    : cloud.online === false
      ? t('cloud.offline', { n: cloud.pending })
      : cloud.pending
        ? t('cloud.pending', { n: cloud.pending })
        : t('cloud.synced', { time: cloud.lastSync ? fmtTime(cloud.lastSync) : '—' });
  return (
    <span className={`sync-status ${cloud.linked && cloud.online !== false && !cloud.pending ? 'is-ok' : ''}`}>
      <i />
      {label}
      {cloud.linked && (
        <button
          className="sync-status__btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await api.syncNow().catch(() => {});
            setBusy(false);
          }}
        >
          {t('cloud.syncNow')}
        </button>
      )}
    </span>
  );
}

function AppUpdate() {
  const { t } = useBun();
  const u = useUpdate();
  if (!u) return null;
  const check = () => bridge.invoke('app:checkUpdate').catch(() => {});
  const text = {
    idle: t('update.auto'),
    checking: t('update.checking'),
    latest: t('update.latest'),
    downloading: t('update.downloading', { v: u.version, p: u.percent ?? 0 }),
    ready: t('update.ready', { v: u.version }),
    manual: t(u.platform === 'darwin' ? 'update.manualMac' : 'update.manual', { v: u.version }),
    error: t('update.error'),
  }[u.state];
  return (
    <div className="settings__row">
      <div>
        <div className="settings__name">
          <Icon name="refresh" size={16} /> {t('update.version', { v: u.current })}
        </div>
        <div className="faint small">{text}</div>
      </div>
      {u.state === 'ready' && (
        <button className="btn btn--sm btn--primary" onClick={() => bridge.send('app:installUpdate')}>
          {t('update.install')}
        </button>
      )}
      {u.state === 'manual' && (
        <button className="btn btn--sm" onClick={() => bridge.send('app:openExternal', CLOUD_URL)}>
          {t('update.download')}
        </button>
      )}
      {['idle', 'latest', 'error'].includes(u.state) && (
        <button className="btn btn--sm" onClick={check}>
          {t('update.check')}
        </button>
      )}
    </div>
  );
}

function IphoneAlarms() {
  const { t, settings } = useBun();
  const alarms = useLive(() => weeklyAlarms(settings.leadMinutes), [settings.leadMinutes], ['tasks']) || [];
  const [state, setState] = useState(loadAlarmState);
  const update = (next) => {
    setState(next);
    saveAlarmState(next);
  };
  const isOff = (a) => state.off.includes(a.seriesId);
  const toAdd = alarms.filter((a) => !isOff(a) && !state.added[a.key]);
  // Added earlier, but the event changed, ended or was switched off: still ringing in Clock.
  const stale = Object.entries(state.added).filter(([key]) => !alarms.some((a) => a.key === key && !isOff(a)));

  return (
    <div className="settings__row settings__row--stack">
      <div className="settings__name">
        <Icon name="clock" size={16} /> {t('alarm.title')}
      </div>
      <div className="faint small">{t('alarm.hint', { n: settings.leadMinutes })}</div>
      {ALARM_SHORTCUT_URL ? (
        <a className="btn btn--sm" href={ALARM_SHORTCUT_URL}>
          {t('alarm.install')}
        </a>
      ) : (
        <div className="faint small">{t('alarm.needShortcut', { name: SHORTCUT_NAME })}</div>
      )}
      {alarms.length === 0 && <div className="faint small">{t('alarm.empty')}</div>}
      {alarms.length > 0 && (
        <div className="alarm-list">
          {alarms.map((a) => (
            <div key={a.seriesId} className={`alarm-row ${isOff(a) ? 'is-off' : ''}`}>
              <span className="alarm-row__when">
                {t(`day.${a.day}`)} {a.time}
              </span>
              <span className="alarm-row__name">{a.name}</span>
              {state.added[a.key] && !isOff(a) && <span className="alarm-row__added">{t('alarm.added')}</span>}
              <button
                className={`switch switch--sm ${isOff(a) ? '' : 'is-on'}`}
                onClick={() => update({ ...state, off: isOff(a) ? state.off.filter((id) => id !== a.seriesId) : [...state.off, a.seriesId] })}
              />
            </div>
          ))}
        </div>
      )}
      {stale.length > 0 && (
        <div className="alarm-stale">
          <div className="small">{t('alarm.stale')}</div>
          {stale.map(([key, a]) => (
            <div key={key} className="small">
              • {t(`day.${a.day}`)} {a.time} · {a.name}
            </div>
          ))}
          <button
            className="btn btn--sm"
            onClick={() => update({ ...state, added: Object.fromEntries(Object.entries(state.added).filter(([key]) => !stale.some(([k]) => k === key))) })}
          >
            {t('alarm.staleDone')}
          </button>
        </div>
      )}
      {toAdd.length > 0 && (
        <a
          className="btn btn--sm btn--primary"
          href={shortcutUrl(toAdd)}
          onClick={() => update({ ...state, added: { ...state.added, ...Object.fromEntries(toAdd.map((a) => [a.key, { day: a.day, time: a.time, name: a.name }])) } })}
        >
          <Icon name="bell" size={14} /> {t('alarm.add', { n: toAdd.length })}
        </a>
      )}
      {toAdd.length === 0 && alarms.some((a) => state.added[a.key]) && (
        <button className="btn btn--sm btn--ghost" onClick={() => update({ ...state, added: {} })}>
          {t('alarm.reset')}
        </button>
      )}
    </div>
  );
}

function PhoneNotifications() {
  const { t, toast } = useBun();
  const [on, setOn] = useState(pushEnabled());
  const [busy, setBusy] = useState(false);
  const needsInstall = isIOS() && !isStandalone();

  const toggle = async () => {
    setBusy(true);
    try {
      if (on) {
        await disablePush();
        setOn(false);
      } else {
        await enablePush();
        setOn(true);
        toast(t('push.enabled'));
      }
    } catch (err) {
      toast(t(`push.err.${err.code || 'PUSH_SERVER'}`), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings__row settings__row--stack">
      <div className="settings__row-inline">
        <div>
          <div className="settings__name">
            <Icon name="phone" size={16} /> {t('push.title')}
          </div>
          <div className="faint small">{needsInstall ? t('push.installFirst') : t('push.hint')}</div>
        </div>
        <button className={`switch ${on ? 'is-on' : ''}`} disabled={busy || (!pushSupported() && !needsInstall)} onClick={toggle} />
      </div>
      {on && (
        <button className="btn btn--sm" onClick={() => testPush().then(() => toast(t('push.testSent')), (err) => toast(`${t('push.err.PUSH_SERVER')} ${err.detail ? `(${err.detail})` : ''}`, 'error'))}>
          <Icon name="bell" size={14} /> {t('push.test')}
        </button>
      )}
    </div>
  );
}
