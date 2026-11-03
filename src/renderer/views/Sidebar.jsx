import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useBun, useLive } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { PetAvatar } from '../sprite.jsx';
import { fmtTime, sameDay, fmtDayMonth } from '../../core/time.js';
import logoUrl from '../assets/logo.svg';

// Friends + chat: the left column on desktop, its own tab on phones.
export default function Sidebar({ mobile = false }) {
  const { user, t, toast, run, lang } = useBun();
  const friends = useLive(() => api.listFriends(), [], ['friends', 'chat']) || [];
  const requests = useLive(() => api.listFriendRequests(), [], ['friends']) || { incoming: [], outgoing: [] };
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('bun-sidebar') === 'collapsed');
  const [chatWith, setChatWith] = useState(null);
  const [adding, setAdding] = useState(false);
  const [handle, setHandle] = useState('');

  useEffect(() => localStorage.setItem('bun-sidebar', collapsed ? 'collapsed' : 'open'), [collapsed]);

  const friend = chatWith && friends.find((f) => f.id === chatWith);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(user.handle);
    } catch {}
    toast(t('fr.copied'));
  };

  const sendRequest = async (e) => {
    e.preventDefault();
    if (!handle.trim()) return;
    const res = await run(api.sendFriendRequest(handle.trim()));
    toast(res.status === 'accepted' ? t('fr.accepted', { name: handle.split('#')[0] }) : t('fr.sent', { name: res.user?.name || handle }));
    setHandle('');
    setAdding(false);
  };

  const respond = async (req, accept) => {
    await run(api.respondFriendRequest(req.id, accept));
    if (accept) toast(t('fr.accepted', { name: req.user.name }));
  };

  const totalUnread = friends.reduce((s, f) => s + f.unread, 0);

  if (collapsed && !mobile) {
    return (
      <aside className="sidebar sidebar--rail">
        <div className="sidebar__top">
          <img src={logoUrl} alt="BUN" className="sidebar__logo" />
        </div>
        <button className="rail-btn" onClick={() => setCollapsed(false)} title={t('fr.expand')}>
          <Icon name="panel" size={18} />
          {totalUnread + requests.incoming.length > 0 && <span className="badge-dot" />}
        </button>
        <div className="rail-list">
          {friends.map((f) => (
            <button
              key={f.id}
              className="rail-friend"
              title={f.name}
              onClick={() => {
                setChatWith(f.id);
                setCollapsed(false);
              }}
            >
              <PetAvatar animal={f.animal} size={38} />
              {f.unread > 0 && <span className="badge">{f.unread}</span>}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className={`sidebar ${mobile ? 'sidebar--page' : ''}`}>
      <div className="sidebar__top" hidden={mobile}>
        <img src={logoUrl} alt="" className="sidebar__logo" />
        <span className="sidebar__brand">BUN</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn icon-btn--sm no-drag" onClick={() => setCollapsed(true)} title={t('fr.collapse')}>
          <Icon name="panel" size={16} />
        </button>
      </div>

      <div className="me-card">
        <PetAvatar animal={user.animal} size={42} />
        <div className="me-card__who">
          <b>{user.name}</b>
          <button className="me-card__id" onClick={copyId} title={t('fr.myId')}>
            #{user.tag} <Icon name="copy" size={12} />
          </button>
        </div>
      </div>

      {friend ? (
        <ChatPanel friend={friend} onBack={() => setChatWith(null)} />
      ) : (
        <div className="friends">
          <div className="friends__head">
            <span>{t('fr.title')}</span>
            <button className={`icon-btn icon-btn--sm ${adding ? 'is-on' : ''}`} onClick={() => setAdding(!adding)} title={t('fr.add')}>
              <Icon name={adding ? 'x' : 'userPlus'} size={16} />
            </button>
          </div>

          {adding && (
            <form className="friends__add" onSubmit={sendRequest}>
              <input className="input input--sm" autoFocus value={handle} placeholder={t('fr.addPh')} onChange={(e) => setHandle(e.target.value)} />
              <button className="btn btn--sm btn--primary" disabled={!handle.includes('#')}>
                {t('fr.send')}
              </button>
            </form>
          )}

          {requests.incoming.length > 0 && (
            <div className="friends__requests">
              <div className="friends__label">{t('fr.requests')}</div>
              {requests.incoming.map((r) => (
                <div key={r.id} className="request">
                  <PetAvatar animal={r.user?.animal} size={34} />
                  <div className="request__who">
                    <b>{r.user?.name}</b>
                    <span className="faint small">#{r.user?.tag}</span>
                  </div>
                  <button className="icon-btn icon-btn--sm request__yes" onClick={() => respond(r, true)} title={t('fr.accept')}>
                    <Icon name="check" size={16} stroke={2.6} />
                  </button>
                  <button className="icon-btn icon-btn--sm" onClick={() => respond(r, false)} title={t('fr.decline')}>
                    <Icon name="x" size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="friends__list">
            {friends.map((f) => (
              <button key={f.id} className="friend" onClick={() => setChatWith(f.id)}>
                <PetAvatar animal={f.animal} size={38} />
                <div className="friend__body">
                  <div className="friend__top">
                    <b>{f.name}</b>
                    {f.lastMessage && <span className="faint small">{sameDay(f.lastMessage.at, new Date()) ? fmtTime(f.lastMessage.at) : fmtDayMonth(f.lastMessage.at, lang)}</span>}
                  </div>
                  <div className={`friend__last ${f.unread ? 'is-unread' : ''}`}>
                    {f.lastMessage ? `${f.lastMessage.mine ? t('chat.you') : ''}${f.lastMessage.text}` : `#${f.tag}`}
                  </div>
                </div>
                {f.unread > 0 && <span className="badge">{f.unread}</span>}
              </button>
            ))}
            {requests.outgoing.map((r) => (
              <div key={r.id} className="friend friend--pending">
                <PetAvatar animal={r.user?.animal} size={38} />
                <div className="friend__body">
                  <b>{r.user?.name}</b>
                  <div className="friend__last">{t('fr.pending')}…</div>
                </div>
              </div>
            ))}
            {friends.length === 0 && requests.outgoing.length === 0 && (
              <div className="friends__empty">
                <p>{t('fr.empty')}</p>
                <button className="chip chip--blue chip--btn" onClick={copyId}>
                  {user.handle} <Icon name="copy" size={12} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

function ChatPanel({ friend, onBack }) {
  const { t, run, lang } = useBun();
  const messages = useLive(() => api.listMessages(friend.id), [friend.id], ['chat']) || [];
  const [text, setText] = useState('');
  const listRef = useRef(null);

  useEffect(() => {
    if (friend.unread) api.markRead(friend.id);
  }, [friend.id, friend.unread, messages.length]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const value = text;
    setText('');
    await run(api.sendMessage(friend.id, value)).catch(() => setText(value));
  };

  return (
    <div className="chat">
      <div className="chat__head">
        <button className="icon-btn icon-btn--sm" onClick={onBack} title={t('nav.back')}>
          <Icon name="arrowLeft" size={16} />
        </button>
        <PetAvatar animal={friend.animal} size={30} />
        <div className="chat__who">
          <b>{friend.name}</b>
          <span className="faint small">#{friend.tag}</span>
        </div>
      </div>
      <div className="chat__list" ref={listRef}>
        {messages.length === 0 && <div className="chat__empty">{t('chat.empty')}</div>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || !sameDay(prev.at, m.at);
          const grouped = prev && prev.mine === m.mine && !newDay && new Date(m.at) - new Date(prev.at) < 5 * 60e3;
          return (
            <div key={m.id}>
              {newDay && <div className="chat__day">{fmtDayMonth(m.at, lang)}</div>}
              <div className={`bubble ${m.mine ? 'bubble--mine' : ''} ${grouped ? 'is-grouped' : ''}`} title={fmtTime(m.at)}>
                {m.text}
              </div>
            </div>
          );
        })}
      </div>
      <form className="chat__input" onSubmit={send}>
        <input className="input input--sm" value={text} placeholder={t('chat.placeholder')} onChange={(e) => setText(e.target.value)} />
        <button className="icon-btn chat__send" disabled={!text.trim()}>
          <Icon name="send" size={17} />
        </button>
      </form>
    </div>
  );
}
