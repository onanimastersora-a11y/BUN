// The pet. On the desktop it lives in its own transparent, always-on-top
// window that ignores the mouse except over the pet and its bubbles. In the web
// / iPhone app the same component is "embedded": a floating corner of the
// app's own screen.
//
// Idle loop (about 10 s each): sleep -> stretch -> walk (bouncy) -> play -> sit
// Click: note box. Drag: move it around. X: hide (alerts bring it back).
// Alerts (task reminders, yesterday's note) grow the pet, play its alert
// animation (the cat scratches the screen, the dog wags its tail) and ring.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, bridge } from '../api.js';
import { makeT } from '../i18n.js';
import { SPRITES, frameAt, animationLength, drawFrame } from '../sprite.jsx';
import { playDing, playRingtone } from '../ringtone.js';
import { dayKey, fmtDate, parseDayKey, addDays } from '../../core/time.js';
import { Icon } from '../icons.jsx';

const PHASES = ['sleep', 'stretch', 'walk', 'play', 'sit'];
const PHASE_MS = 10000;
const WALK_SPEED = 28; // px per second
const ALERT_SCALE = 1.35;
const ALERT_TIMEOUT = 3 * 60 * 1000;
const EMBED_POS_KEY = 'bun-pet-pos';

// Opaque bounds of a frame, used to place the X button and bubbles near the head.
function frameBounds(sprite, frame) {
  const rows = sprite.frames[frame];
  let minX = Infinity, maxX = -1, minY = Infinity;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '.') continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
    }
  });
  return { minX, maxX, minY };
}

function walkPlan(x0, range) {
  const pts = [x0, range, -range, 0];
  const segs = [];
  let t = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.abs(pts[i] - pts[i - 1]);
    const dur = (d / WALK_SPEED) * 1000;
    segs.push({ from: pts[i - 1], to: pts[i], t0: t, dur });
    t += dur;
  }
  return { segs, total: t };
}

function readEmbedPos() {
  try {
    return JSON.parse(localStorage.getItem(EMBED_POS_KEY)) || { right: 4, bottom: 4 };
  } catch {
    return { right: 4, bottom: 4 };
  }
}

export default function Pet({ embedded = false, hidden = false, onHide }) {
  const [session, setSession] = useState(null);
  const [mode, setMode] = useState('loop'); // loop | note | notes | alert
  const [alerts, setAlerts] = useState([]);
  const [note, setNote] = useState('');
  const [history, setHistory] = useState([]);
  const [focusDay, setFocusDay] = useState(null);
  const [pos, setPos] = useState(readEmbedPos);
  // Desktop: where the pet's feet are inside the (screen-clamped) window.
  const [place, setPlace] = useState(() => ({ x: window.innerWidth / 2, y: window.innerHeight - 10, width: window.innerWidth, height: window.innerHeight }));
  const [sent, setSent] = useState(null);

  const canvasRef = useRef(null);
  const actorRef = useRef(null);
  const bodyRef = useRef(null);
  const rootRef = useRef(null);
  const loop = useRef({ phase: 4, phaseStart: performance.now(), anim: null, animStart: 0, frame: null, flip: false, x: 0, plan: null });
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const ignoring = useRef(true);
  const dragging = useRef(false);
  const saveTimer = useRef(null);

  const user = session?.user;
  const settings = session?.settings;
  const animal = user?.animal || 'cat';
  // A phone screen gets the small pet.
  const scale = embedded ? Math.min(2, settings?.petScale || 2) : settings?.petScale || 3;
  const W = SPRITES[animal].width * scale;
  const H = SPRITES[animal].height * scale;
  // Walk only as far as the window allows on each side.
  const walkRange = embedded ? 36 : Math.max(0, Math.min(70, place.x - W / 2 - 4, place.width - place.x - W / 2 - 4));
  const t = useMemo(() => makeT(settings?.language || 'en'), [settings?.language]);
  const sprite = SPRITES[animal];
  const phases = useMemo(() => PHASES.filter((p) => p !== 'play' || sprite.animations.play), [sprite]);
  const alert = alerts[0];

  // ---------- data ----------

  const loadSession = useCallback(async () => {
    const s = await api.getSession();
    setSession(s);
    if (s) {
      setNote(await api.getNote(dayKey()));
      setHistory(await api.getNotes());
    }
  }, []);

  useEffect(() => {
    loadSession().then(() => bridge.send('pet:ready'));
    const offChanged = bridge.on('bun:changed', (topics) => {
      if (topics.includes('session') || topics.includes('settings')) loadSession();
      else if (topics.includes('notes')) {
        api.getNotes().then(setHistory).catch(() => {});
        // Today's note changed elsewhere (main window, another device): show it, unless it's being typed here.
        const typing = saveTimer.current || document.activeElement?.matches?.('.pet-note, .pet-notes textarea');
        if (!typing) api.getNote(dayKey()).then(setNote).catch(() => {});
      }
    });
    const offAlert = bridge.on('pet:alert', (a) => setAlerts((list) => [...list, a]));
    const offPlace = bridge.on('pet:place', (p) => {
      setPlace(p);
      loop.current.x = 0;
    });
    window.__petAlert = (a) => setAlerts((list) => [...list, a]); // preview / test helper
    return () => {
      offChanged();
      offAlert();
      offPlace();
    };
  }, [loadSession]);

  // Tell the main process how big the pet is, so it keeps all of it on screen.
  useEffect(() => {
    if (!embedded) bridge.send('pet:size', { w: W, h: H });
  }, [W, H, embedded]);

  useEffect(() => {
    if (!embedded) document.documentElement.dataset.theme = settings?.theme || 'light';
  }, [settings?.theme, embedded]);

  // Alerts take over the stage until dismissed, with the ringtone playing.
  useEffect(() => {
    if (!alert) {
      if (modeRef.current === 'alert') setMode('loop');
      return;
    }
    setMode('alert');
    const sound = alert.kind === 'task' ? playRingtone(settings?.ringtone) : playDing(settings?.ringtone?.volume ?? 0.7);
    const id = setTimeout(() => setAlerts((l) => l.slice(1)), ALERT_TIMEOUT);
    return () => {
      clearTimeout(id);
      sound.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alert]);

  const dismissAlert = () => setAlerts((l) => l.slice(1));

  const saveNote = (text) => {
    setNote(text);
    clearTimeout(saveTimer.current);
    // A lone "- " is still an empty note.
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      api.saveNote(text.trim() === '-' ? '' : text, dayKey());
    }, 450);
  };

  // Notes are bullet lists: start with "- ", and Enter starts the next bullet
  // (Enter on an empty bullet ends the list).
  const onNoteFocus = (e) => {
    if (!note) {
      saveNote('- ');
      requestAnimationFrame(() => e.target.setSelectionRange(2, 2));
    }
  };
  // Reopening today's note: continue typing at the end, not before the first line.
  const caretToEnd = useCallback((el) => {
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const onNoteKey = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const lineStart = value.lastIndexOf('\n', a - 1) + 1;
    const line = value.slice(lineStart, a);
    e.preventDefault();
    if (line.trim() === '-') {
      const next = value.slice(0, lineStart) + value.slice(a);
      saveNote(next);
      requestAnimationFrame(() => el.setSelectionRange(lineStart, lineStart));
      return;
    }
    const next = `${value.slice(0, a)}\n- ${value.slice(b)}`;
    saveNote(next);
    requestAnimationFrame(() => el.setSelectionRange(a + 3, a + 3));
  };

  // Each bullet becomes a task on the checklist board last opened.
  const sendToChecklist = async () => {
    const names = note
      .split('\n')
      .map((l) => l.replace(/^\s*[-•*]\s*/, '').trim())
      .filter(Boolean);
    if (!names.length) return;
    const boards = await api.listBoards();
    const board = boards.find((b) => b.id === settings?.lastBoardId) || boards[0];
    if (!board) return;
    for (const name of names) await api.createTask({ boardId: board.id, name });
    setSent({ n: names.length, board: board.name });
    setTimeout(() => setSent(null), 3500);
  };

  // ---------- animation loop ----------

  useEffect(() => {
    if (!user) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const L = loop.current;
    L.anim = null;
    L.frame = null;
    L.phase = Math.min(L.phase, phases.length - 1);
    let raf;

    const tick = (now) => {
      const m = modeRef.current;
      let anim;
      let x = L.x;
      let flip = L.flip;
      let bounce = 0;

      if (m === 'alert') anim = 'alert';
      else if (m !== 'loop' || dragging.current) anim = 'sit';
      else {
        let elapsed = now - L.phaseStart;
        let phase = phases[L.phase];
        const len = phase === 'walk' ? (L.plan ||= walkPlan(L.x, walkRange)).total : PHASE_MS;
        if (elapsed >= len) {
          L.phase = (L.phase + 1) % phases.length;
          L.phaseStart = now;
          L.plan = null;
          elapsed = 0;
          phase = phases[L.phase];
          if (phase === 'walk') L.plan = walkPlan(L.x, walkRange);
        }
        if (phase === 'sleep') anim = elapsed < animationLength(animal, 'liedown') ? 'liedown' : 'sleep';
        else if (phase === 'walk') {
          anim = 'walk';
          const seg = L.plan.segs.find((s) => elapsed < s.t0 + s.dur) || L.plan.segs[L.plan.segs.length - 1];
          const k = Math.min(1, (elapsed - seg.t0) / seg.dur);
          x = seg.from + (seg.to - seg.from) * k;
          flip = seg.to < seg.from;
          bounce = -Math.abs(Math.sin((elapsed / 300) * Math.PI)) * scale * 1.5;
        } else anim = phase;
        if (anim !== 'walk') flip = false;
      }

      if (anim !== L.anim) {
        L.anim = anim;
        L.animStart = now;
      }
      const { frame } = frameAt(sprite.animations[anim], now - L.animStart);
      if (frame !== L.frame || flip !== L.flip) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawFrame(ctx, animal, frame, 0, 0, scale, flip);
        L.frame = frame;
      }
      L.flip = flip;
      L.x = x;
      if (actorRef.current) {
        actorRef.current.style.transform = `translateX(${Math.round(x)}px)`;
        actorRef.current.dataset.anim = anim;
      }
      if (bodyRef.current) bodyRef.current.style.translate = `0 ${Math.round(bounce)}px`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [user, animal, scale, sprite, phases, walkRange]);

  // Keep an open bubble inside the window: slide it sideways, its tail still points at the pet.
  useLayoutEffect(() => {
    const actor = actorRef.current;
    const bubble = actor?.querySelector('.pet-bubble');
    if (!bubble) return;
    const r = actor.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const w = bubble.offsetWidth;
    const left = Math.min(Math.max(8, cx - w / 2), window.innerWidth - 8 - w);
    const shift = Math.max(-(w / 2 - 22), Math.min(w / 2 - 22, left - (cx - w / 2)));
    bubble.style.setProperty('--shift', `${Math.round(shift)}px`);
  }, [mode, place, alerts.length, sent, pos]);

  // ---------- click-through (desktop window only) ----------

  useEffect(() => {
    if (embedded) return;
    const setIgnore = (v) => {
      if (ignoring.current === v) return;
      ignoring.current = v;
      bridge.send('pet:ignoreMouse', v);
    };
    const overPet = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return false;
      if (el === canvasRef.current) {
        // Only opaque pixels of the sprite count (with a little slack).
        const r = el.getBoundingClientRect();
        const ctx = el.getContext('2d');
        const sx = ((e.clientX - r.left) / r.width) * el.width;
        const sy = ((e.clientY - r.top) / r.height) * el.height;
        const d = ctx.getImageData(Math.max(0, sx - 4), Math.max(0, sy - 4), 9, 9).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
        return false;
      }
      return !!el.closest('[data-hit]');
    };
    const onMove = (e) => {
      if (dragging.current) return;
      const hit = overPet(e);
      setIgnore(!hit);
      document.body.classList.toggle('is-hovering', hit);
    };
    const onLeave = () => {
      if (dragging.current) return;
      setIgnore(true);
      document.body.classList.remove('is-hovering');
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
    };
  }, [embedded]);

  // ---------- drag / click on the pet ----------

  const moveBy = (dx, dy) => {
    if (!embedded) return bridge.send('pet:moveBy', { dx, dy });
    const el = rootRef.current;
    setPos((p) => {
      const maxRight = window.innerWidth - (el?.offsetWidth || 300) / 2 - 40;
      const maxBottom = window.innerHeight - 140;
      return { right: Math.max(-80, Math.min(maxRight, p.right - dx)), bottom: Math.max(-6, Math.min(maxBottom, p.bottom - dy)) };
    });
  };

  const onPetDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let lastX = e.screenX;
    let lastY = e.screenY;
    let total = 0;
    const move = (ev) => {
      const dx = ev.screenX - lastX;
      const dy = ev.screenY - lastY;
      if (!dx && !dy) return;
      total += Math.abs(dx) + Math.abs(dy);
      if (total > 6) {
        dragging.current = true;
        document.body.classList.add('is-dragging');
        moveBy(dx, dy);
      }
      lastX = ev.screenX;
      lastY = ev.screenY;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-dragging');
      if (dragging.current) {
        dragging.current = false;
        if (embedded) setPos((p) => (localStorage.setItem(EMBED_POS_KEY, JSON.stringify(p)), p));
        else bridge.send('pet:dragEnd');
        return;
      }
      // A click: open the note box ready for typing (or close it).
      if (modeRef.current === 'alert') dismissAlert();
      else if (modeRef.current === 'loop') {
        if (!embedded) bridge.send('pet:focus');
        setMode('note');
      } else setMode('loop');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const hidePet = () => {
    setMode('loop');
    if (embedded) onHide?.();
    else bridge.send('pet:hide');
  };

  if (!user) return null;
  // Embedded pets stay hidden after X until a reminder arrives.
  if (embedded && hidden && !alert) return null;

  const meta = sprite.meta || {};
  const metaPos = (pt) => (pt ? { left: pt[0] * scale, top: pt[1] * scale } : null);
  const bounds = frameBounds(sprite, sprite.animations.sit.seq[0][0]);
  const headTop = H - bounds.minY * scale; // distance from the feet to the top of the head
  const grownTop = mode === 'alert' ? headTop * ALERT_SCALE : headTop;
  // Desktop: bubbles go above the pet when there's room, else below it.
  const roomAbove = embedded ? Infinity : place.y - grownTop;
  const roomBelow = embedded ? 0 : place.height - place.y;
  const below = !embedded && roomAbove < 200 && roomBelow > roomAbove;
  const bubbleStyle = below ? { top: H + 14 } : { bottom: grownTop + 14 };
  const notesStyle = embedded
    ? undefined
    : below
      ? { top: place.y + 12, bottom: 'auto', maxHeight: place.height - place.y - 20 }
      : { top: 10, maxHeight: place.y - grownTop - 26 };
  const noteProps = {
    value: note,
    placeholder: t('pet.notePh'),
    onFocus: onNoteFocus,
    onKeyDown: onNoteKey,
    onChange: (e) => saveNote(e.target.value),
    spellCheck: false,
  };
  const yesterday = dayKey(addDays(new Date(), -1));
  const lang = settings?.language || 'en';
  const pastNotes = history.filter((n) => n.day !== dayKey());

  return (
    <div
      ref={rootRef}
      className={`pet-root pet-root--${animal} mode-${mode} ${embedded ? 'pet-root--embedded' : ''}`}
      style={embedded ? { right: pos.right, bottom: pos.bottom } : undefined}
      // Take keyboard focus only for typing notes; dragging the pet leaves the user's app focused.
      onPointerDown={(e) => !embedded && e.target.closest('.pet-bubble--note, .pet-notes') && bridge.send('pet:focus')}
    >
      <div className="pet-anchor" style={embedded ? undefined : { left: place.x - W / 2, top: place.y - H }}>
      <div className={`pet-actor ${below ? 'is-below' : ''}`} ref={actorRef} style={{ width: W, '--pet-h': `${headTop}px` }}>
        {/* bubbles sit above the pet and follow it */}
        {mode === 'note' && (
          <div className="pet-bubble pet-bubble--note" data-hit style={bubbleStyle}>
            <div className="pet-bubble__tools">
              <button title={t('pet.toChecklist')} onClick={sendToChecklist} disabled={!note.replace(/[-\s]/g, '')}>
                <Icon name="send" size={13} />
              </button>
              <button title={t('pet.expand')} onClick={() => setMode('notes')}>
                <Icon name="list" size={14} />
              </button>
              <button title={t('set.close')} onClick={() => setMode('loop')}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <textarea className="pet-note" autoFocus ref={caretToEnd} {...noteProps} />
            {sent && <div className="pet-sent">{t('pet.sentToChecklist', { n: sent.n, board: sent.board })}</div>}
          </div>
        )}

        {mode === 'alert' && alert && (
          <div className="pet-bubble pet-bubble--alert" data-hit key={alerts.length} style={bubbleStyle}>
            {alert.kind === 'task' ? (
              <p className="pet-alert__text">{t(alert.task.kind === 'deadline' ? 'pet.deadlineAlert' : 'pet.taskAlert', { name: alert.task.name, n: alert.task.minutes })}</p>
            ) : (
              <>
                <p className="pet-alert__text">{alert.day === yesterday ? t('pet.recapYesterday') : t('pet.recapDay', { date: fmtDate(parseDayKey(alert.day), lang) })}</p>
                <blockquote className="pet-alert__quote">{alert.text.length > 160 ? `${alert.text.slice(0, 160)}…` : alert.text}</blockquote>
              </>
            )}
            <div className="pet-alert__actions">
              {alert.kind === 'recap' && (
                <button
                  className="pet-btn"
                  onClick={() => {
                    dismissAlert();
                    setFocusDay(alert.day);
                    setMode('notes');
                  }}
                >
                  {t('pet.view')}
                </button>
              )}
              {alert.kind === 'task' && alert.task.boardId && (
                <button
                  className="pet-btn"
                  onClick={() => {
                    dismissAlert();
                    if (embedded) bridge.emit?.('bun:navigate', { view: 'board', boardId: alert.task.boardId });
                    else bridge.send('pet:openBoard', alert.task.boardId);
                  }}
                >
                  {t('task.openBoard')}
                </button>
              )}
              <button className="pet-btn pet-btn--primary" onClick={dismissAlert}>
                {t('pet.ok')}
              </button>
            </div>
          </div>
        )}

        <button className="pet-x" data-hit title={t('pet.close')} onClick={hidePet} style={{ left: (bounds.maxX + 1) * scale - 6, top: bounds.minY * scale - 8 }}>
          <Icon name="x" size={11} stroke={3} />
        </button>

        <div className="pet-scale" style={{ transform: mode === 'alert' ? `scale(${ALERT_SCALE})` : 'scale(1)' }}>
          <div className="pet-body" ref={bodyRef}>
            <canvas ref={canvasRef} width={W} height={H} className="pet-canvas" onPointerDown={onPetDown} />
            {/* overlays */}
            <div className="pet-zzz" style={metaPos(meta.zzz)}>
              <span>z</span>
              <span>z</span>
              <span>Z</span>
            </div>
            {animal === 'cat' && mode === 'alert' && (
              <div className="pet-scratch" style={metaPos(meta.scratch)}>
                {[0, 1, 2].map((i) => (
                  <span key={i} className={`claw claw--${i}`}>
                    <i />
                    <i />
                    <i />
                  </span>
                ))}
              </div>
            )}
            {animal === 'dog' && mode === 'alert' && (
              <div className="pet-hearts" style={metaPos(meta.tail)}>
                {[0, 1, 2].map((i) => (
                  <span key={i} className={`heart heart--${i}`} />
                ))}
              </div>
            )}
          </div>
          <div className="pet-shadow" style={{ width: W * 0.62 }} />
        </div>
      </div>
      </div>

      {mode === 'notes' && (
        <div className="pet-notes" data-hit style={notesStyle}>
          <div className="pet-notes__head">
            <b>{t('pet.notesTitle', { name: user.name })}</b>
            <button title={t('pet.toChecklist')} onClick={sendToChecklist}>
              <Icon name="send" size={14} />
            </button>
            <button title={t('pet.collapse')} onClick={() => setMode('note')}>
              <Icon name="chevronDown" size={15} />
            </button>
            <button title={t('set.close')} onClick={() => setMode('loop')}>
              <Icon name="x" size={15} />
            </button>
          </div>
          <div className="pet-notes__body">
            <div className="pet-notes__day is-today">
              <div className="pet-notes__label">
                {t('pet.today')} · {fmtDate(new Date(), lang)}
              </div>
              <textarea {...noteProps} />
              {sent && <div className="pet-sent">{t('pet.sentToChecklist', { n: sent.n, board: sent.board })}</div>}
            </div>
            {pastNotes.length === 0 && <div className="pet-notes__empty">{t('pet.noHistory')}</div>}
            {pastNotes.map((n) => (
              <details key={n.day} className="pet-notes__day" open={focusDay === n.day || undefined}>
                <summary className="pet-notes__label">{t('pet.noteOf', { date: fmtDate(parseDayKey(n.day), lang) })}</summary>
                <p>{n.text}</p>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
