import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useBun, useLive, useNow, useIsMobile } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { TaskEditor, Assignees } from '../components/TaskFields.jsx';
import { addDays, dayKey, fmtDayMonth, fmtTime, sameDay, startOfDay, startOfWeek, MINUTE } from '../../core/time.js';

const HOUR_H = 64;
const SNAP = 15; // minutes

const minutesOfDay = (date, day) => (new Date(date).getTime() - startOfDay(day).getTime()) / MINUTE;

function fmtDuration(ms, t) {
  const m = Math.round(ms / MINUTE);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return t('cal.min', { n: r });
  return r ? t('cal.hourMin', { h, m: r }) : t('cal.hour', { h });
}

// Side-by-side columns for overlapping blocks within one day.
function layoutDay(blocks) {
  const sorted = [...blocks].sort((a, b) => a.top - b.top || b.height - a.height);
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = [];
    for (const b of cluster) {
      let c = cols.findIndex((end) => end <= b.top);
      if (c === -1) c = cols.push(0) - 1;
      cols[c] = b.top + b.height;
      b.col = c;
    }
    for (const b of cluster) out.push({ ...b, cols: cols.length });
    cluster = [];
  };
  for (const b of sorted) {
    if (b.top >= clusterEnd && cluster.length) flush();
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.top + b.height);
  }
  flush();
  return out;
}

export default function CalendarView({ initialDate }) {
  const { t, lang, run } = useBun();
  const mobile = useIsMobile();
  const now = useNow(30000);
  const [anchorDay, setAnchorDay] = useState(() => startOfDay(initialDate ? new Date(initialDate) : new Date()));
  const weekStart = startOfWeek(anchorDay);
  const weekEnd = addDays(weekStart, 7);
  const items = useLive(() => api.listCalendar(weekStart.toISOString(), weekEnd.toISOString()), [dayKey(weekStart)], ['tasks', 'boards']) || [];
  const [editor, setEditor] = useState(null); // { anchor, task?, draft? }
  const [drag, setDrag] = useState(null); // { id, start, end, mode }
  const scrollRef = useRef(null);
  const daysRef = useRef(null);

  useLayoutEffect(() => {
    const h = Math.max(0, Math.min(new Date().getHours() - 1, 7));
    if (scrollRef.current) scrollRef.current.scrollTop = h * HOUR_H;
  }, []);

  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  // Phones show one day at a time; the week strip on top picks it.
  const days = mobile ? [anchorDay] : week;

  const shown = items.map((it) => (drag && drag.id === it.id ? { ...it, start: drag.start, end: drag.end } : it));

  const blocksFor = (day) => {
    const dayStart = startOfDay(day).getTime();
    const dayEnd = dayStart + 24 * 60 * MINUTE;
    const blocks = shown
      .filter((it) => new Date(it.start).getTime() < dayEnd && new Date(it.end).getTime() > dayStart)
      .map((it) => {
        const s = Math.max(new Date(it.start).getTime(), dayStart);
        const e = Math.min(new Date(it.end).getTime(), dayEnd);
        return {
          item: it,
          top: ((s - dayStart) / MINUTE / 60) * HOUR_H,
          height: Math.max(16, ((e - s) / MINUTE / 60) * HOUR_H),
          clippedTop: s > new Date(it.start).getTime(),
          clippedBottom: e < new Date(it.end).getTime(),
        };
      });
    return layoutDay(blocks);
  };

  const shiftWeek = (n) => setAnchorDay(addDays(anchorDay, n * 7));
  const shiftDay = (n) => setAnchorDay(addDays(anchorDay, n));

  // ----- create -----
  const onColumnClick = (e, day) => {
    if (e.target.closest('.cal-block')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const hour = Math.max(0, Math.min(23, Math.floor(y / HOUR_H)));
    const start = new Date(startOfDay(day));
    start.setHours(hour);
    const end = new Date(start.getTime() + 60 * MINUTE);
    setEditor({ anchor: { x: e.clientX, y: e.clientY }, draft: { boardId: null, start: start.toISOString(), end: end.toISOString() }, quick: true });
  };

  // ----- move / resize -----
  const startDrag = (e, item, mode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const scroll0 = scrollRef.current.scrollTop;
    const s0 = new Date(item.start).getTime();
    const e0 = new Date(item.end).getTime();
    const daysRect = daysRef.current.getBoundingClientRect();
    const colW = daysRect.width / days.length;
    const dayIdx0 = Math.floor((startX - daysRect.left) / colW);
    let moved = false;
    let shown = false;
    let latest = { start: item.start, end: item.end };
    const snap = (ms) => Math.round(ms / (SNAP * MINUTE)) * SNAP * MINUTE;

    const onMove = (ev) => {
      // Count auto-scroll of the grid as movement too.
      const dy = ev.clientY - startY + (scrollRef.current.scrollTop - scroll0);
      if (!moved && Math.abs(dy) < 4 && Math.abs(ev.clientX - startX) < 4) return;
      moved = true;
      const dMin = snap((dy / HOUR_H) * 60 * MINUTE);
      let ns = s0;
      let ne = e0;
      if (mode === 'top') ns = Math.min(s0 + dMin, e0 - SNAP * MINUTE);
      else if (mode === 'bottom') ne = Math.max(e0 + dMin, s0 + SNAP * MINUTE);
      else {
        const dayIdx = Math.max(0, Math.min(days.length - 1, Math.floor((ev.clientX - daysRect.left) / colW)));
        const dDay = (dayIdx - dayIdx0) * 24 * 60 * MINUTE;
        ns = s0 + dMin + dDay;
        ne = e0 + dMin + dDay;
      }
      const next = { start: new Date(ns).toISOString(), end: new Date(ne).toISOString() };
      // Only re-render when the snapped time actually changes.
      if (shown && next.start === latest.start && next.end === latest.end) return;
      shown = true;
      latest = next;
      setDrag({ id: item.id, ...latest, mode });
    };
    const onUp = async (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) {
        setDrag(null);
        if (mode === 'move') setEditor({ anchor: { x: ev.clientX, y: ev.clientY }, task: item });
        return;
      }
      try {
        await run(api.updateTask(item.id, latest));
      } finally {
        setDrag(null);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const nowTop = (minutesOfDay(now, now) / 60) * HOUR_H;
  const draftBlock = editor?.draft;

  // Swipe left / right on phones to change the day.
  const swipe = useRef(null);
  const onTouchStart = (e) => {
    const t0 = e.touches[0];
    swipe.current = { x: t0.clientX, y: t0.clientY };
  };
  const onTouchEnd = (e) => {
    if (!swipe.current || drag) return;
    const t1 = e.changedTouches[0];
    const dx = t1.clientX - swipe.current.x;
    const dy = t1.clientY - swipe.current.y;
    swipe.current = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftDay(dx < 0 ? 1 : -1);
  };

  return (
    <div className={`cal ${drag ? 'is-dragging' : ''} ${mobile ? 'cal--mobile' : ''}`}>
      <div className="cal__toolbar">
        <h2 className="view-title">{t('cal.title')}</h2>
        <span className="cal__range">
          {fmtDayMonth(weekStart, lang)} – {fmtDayMonth(addDays(weekStart, 6), lang)}, {addDays(weekStart, 6).getFullYear()}
        </span>
        <span className="cal__spacer" />
        {!mobile && <span className="cal__hint faint">{t('cal.hint')}</span>}
        <div className="cal__nav">
          <button className="icon-btn" title={t('cal.prevWeek')} onClick={() => shiftWeek(-1)}>
            <Icon name="chevronLeft" />
          </button>
          <button className="btn btn--sm" onClick={() => setAnchorDay(startOfDay(new Date()))}>
            {t('cal.today')}
          </button>
          <button className="icon-btn" title={t('cal.nextWeek')} onClick={() => shiftWeek(1)}>
            <Icon name="chevronRight" />
          </button>
        </div>
      </div>

      {mobile && (
        <div className="cal__strip">
          {week.map((d, i) => (
            <button key={i} className={`cal__strip-day ${sameDay(d, anchorDay) ? 'is-on' : ''} ${sameDay(d, now) ? 'is-today' : ''}`} onClick={() => setAnchorDay(d)}>
              <span>{t(`day.${i}`)}</span>
              <b>{d.getDate()}</b>
              {items.some((it) => sameDay(it.start, d)) && <i />}
            </button>
          ))}
        </div>
      )}

      <div className="cal__frame card">
        <div className="cal__head" style={{ gridTemplateColumns: `58px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div className="cal__gutter-head" />
          {days.map((d) => {
            const i = (d.getDay() + 6) % 7;
            return (
              <div key={dayKey(d)} className={`cal__dayhead ${sameDay(d, now) ? 'is-today' : ''}`}>
                <span className="cal__weekday">{t(`dayLong.${i}`)}</span>
                <span className="cal__date">{fmtDayMonth(d, lang)}</span>
              </div>
            );
          })}
        </div>
        <div className="cal__scroll" ref={scrollRef} onTouchStart={mobile ? onTouchStart : undefined} onTouchEnd={mobile ? onTouchEnd : undefined}>
          <div className="cal__grid" style={{ height: 24 * HOUR_H }}>
            <div className="cal__gutter">
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="cal__hour" style={{ top: h * HOUR_H }}>
                  {h > 0 && `${String(h).padStart(2, '0')}:00`}
                </div>
              ))}
            </div>
            <div className="cal__days" ref={daysRef} style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
              {drag && (
                // 15 / 30 / 45 minute guides while dragging.
                <div className="cal__quarters">
                  {Array.from({ length: 24 * 4 }, (_, q) =>
                    q % 4 ? <div key={q} className={`cal__quarter ${q % 2 ? '' : 'is-half'}`} style={{ top: (q / 4) * HOUR_H }} /> : null,
                  )}
                </div>
              )}
              {days.map((day) => (
                <div key={dayKey(day)} className={`cal__col ${sameDay(day, now) ? 'is-today' : ''}`} onClick={(e) => onColumnClick(e, day)}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="cal__slot" style={{ top: h * HOUR_H, height: HOUR_H }} />
                  ))}
                  {draftBlock && sameDay(draftBlock.start, day) && (
                    <div className="cal-block cal-block--ghost" style={{ top: (minutesOfDay(draftBlock.start, day) / 60) * HOUR_H, height: HOUR_H - 2 }}>
                      <span className="cal-block__time">
                        {fmtTime(draftBlock.start)} – {fmtTime(draftBlock.end)}
                      </span>
                    </div>
                  )}
                  {blocksFor(day).map(({ item, top, height, col, cols, clippedTop, clippedBottom }) => {
                    const active = drag?.id === item.id;
                    const size = height < 30 ? 'is-tiny' : height < 56 ? 'is-short' : '';
                    return (
                      <div
                        key={item.id}
                        className={`cal-block ${item.boardId ? 'cal-block--board' : ''} ${item.done ? 'is-done' : ''} ${active ? 'is-active' : ''} ${size}`}
                        style={{ top, height: height - 2, left: `calc(${(col / cols) * 100}% + 3px)`, width: `calc(${100 / cols}% - 6px)` }}
                        title={`${fmtTime(item.start)} – ${fmtTime(item.end)} · ${item.name}`}
                        onPointerDown={(e) => startDrag(e, item, 'move')}
                      >
                        {!clippedTop && <div className="cal-block__edge cal-block__edge--top" onPointerDown={(e) => startDrag(e, item, 'top')} />}
                        <div className="cal-block__body">
                          <span className="cal-block__time">
                            {fmtTime(item.start)} – {fmtTime(item.end)}
                          </span>
                          <span className="cal-block__name">{item.name}</span>
                          {item.role && <span className="cal-block__role">{item.role}</span>}
                        </div>
                        {item.assigneeUsers?.length > 0 && height >= 72 && (
                          <span className="cal-block__people">
                            <Assignees users={item.assigneeUsers} size={18} />
                          </span>
                        )}
                        {!clippedBottom && <div className="cal-block__edge cal-block__edge--bottom" onPointerDown={(e) => startDrag(e, item, 'bottom')} />}
                        {active && (
                          // Always-visible time while extending / moving.
                          <div className={`cal-badge cal-badge--${drag.mode === 'top' ? 'top' : drag.mode === 'bottom' ? 'bottom' : 'top'}`}>
                            <b>
                              {fmtTime(drag.start)} – {fmtTime(drag.end)}
                            </b>
                            <span>{fmtDuration(new Date(drag.end) - new Date(drag.start), t)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {sameDay(day, now) && (
                    <div className="cal__now" style={{ top: nowTop }}>
                      <span />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {editor && (
        <TaskEditor
          key={editor.task?.id || editor.draft?.start}
          anchor={editor.anchor}
          task={editor.task}
          draft={editor.draft}
          quick={editor.quick}
          placement={mobile ? 'bottom' : 'right'}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
