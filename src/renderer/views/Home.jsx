import { useState } from 'react';
import { api } from '../api.js';
import { useBun, useLive, useNow } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { PixelSprite } from '../sprite.jsx';
import { Popover } from '../components/Popover.jsx';
import { addDays, dayKey, fmtDate, fmtDayMonth, fmtTime, sameDay, startOfWeek } from '../../core/time.js';
import { numberTasks } from './board/tree.js';
import DailyBoard from './DailyBoard.jsx';

function originOf(e) {
  return { x: e.clientX, y: e.clientY - 40 };
}

export default function Home() {
  const { user, settings, t, lang, navigate } = useBun();
  const now = useNow(60000);
  const weekStart = startOfWeek(now);
  const weekEnd = addDays(weekStart, 7);
  const items = useLive(() => api.listCalendar(weekStart.toISOString(), weekEnd.toISOString()), [dayKey(weekStart)], ['tasks', 'boards']) || [];
  const boards = useLive(() => api.listBoards(), [], ['boards']) || [];
  const boardId = boards.find((b) => b.id === settings.lastBoardId)?.id || boards[0]?.id;
  const board = useLive(() => (boardId ? api.getBoard(boardId) : null), [boardId], ['tasks', 'boards']);
  const [switcher, setSwitcher] = useState(null);

  const hour = now.getHours();
  const greet = hour < 11 ? 'home.morning' : hour < 18 ? 'home.afternoon' : 'home.evening';
  const todayCount = items.filter((i) => sameDay(i.start, now)).length;

  const openBoard = (e, id = boardId) => {
    api.updateSettings({ lastBoardId: id });
    navigate({ view: 'board', boardId: id, enter: 'zoom', origin: originOf(e) });
  };

  const newBoard = async (e) => {
    const b = await api.createBoard(t('board.newBoardName'));
    setSwitcher(null);
    openBoard(e, b.id);
  };

  const rows = board ? numberTasks(board.tasks).filter((r) => r.task.name) : [];

  return (
    <div className="home">
      <section className="hero">
        <div className={`hero__stage hero__stage--${user.animal}`}>
          <PixelSprite animal={user.animal} anim="sit" scale={3} />
        </div>
        <div className="hero__text">
          <div className="hero__date">
            {t(`dayLong.${(now.getDay() + 6) % 7}`)}, {fmtDate(now, lang)}
          </div>
          <h1 className="hero__title">{t(greet, { name: user.name })}</h1>
          <p className="hero__sub">{todayCount === 0 ? t('home.todayNone') : todayCount === 1 ? t('home.todayOne') : t('home.todayCount', { n: todayCount })}</p>
        </div>
      </section>

      <section className="home__grid">
        <button className="mini mini--schedule card" onClick={(e) => navigate({ view: 'calendar', enter: 'zoom', origin: originOf(e) })}>
          <div className="mini__head">
            <span className="mini__icon mini__icon--blue">
              <Icon name="calendar" size={17} />
            </span>
            <span className="mini__title">{t('home.schedule')}</span>
            <span className="mini__meta">
              {fmtDayMonth(weekStart, lang)} – {fmtDayMonth(addDays(weekStart, 6), lang)}
            </span>
            <Icon name="chevronRight" size={18} className="mini__go" />
          </div>
          <div className="week-mini">
            {Array.from({ length: 7 }, (_, i) => {
              const day = addDays(weekStart, i);
              const dayItems = items.filter((it) => sameDay(it.start, day));
              const isToday = sameDay(day, now);
              return (
                <div key={i} className={`week-mini__day ${isToday ? 'is-today' : ''}`}>
                  <div className="week-mini__label">
                    <span>{t(`day.${i}`)}</span>
                    <b>{day.getDate()}</b>
                  </div>
                  <div className="week-mini__items">
                    {dayItems.slice(0, 4).map((it) => (
                      <div key={it.id} className={`week-mini__item ${it.kind === 'deadline' ? 'is-deadline' : ''}`} title={it.name}>
                        <span>
                          {it.kind === 'deadline' && '⚑ '}
                          {fmtTime(it.start)}
                        </span>
                        {it.name}
                      </div>
                    ))}
                    {dayItems.length > 4 && <div className="week-mini__more">{t('home.moreItems', { n: dayItems.length - 4 })}</div>}
                    {dayItems.length === 0 && <div className="week-mini__empty">{t('home.emptyDay')}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </button>

        <div className="mini mini--checklist card" role="button" tabIndex={0} onClick={(e) => boardId && openBoard(e)}>
          <div className="mini__head">
            <span className="mini__icon">
              <Icon name="list" size={17} />
            </span>
            <span className="mini__title mini__title--board">{board?.name || t('home.checklist')}</span>
            <button
              className="icon-btn icon-btn--sm"
              data-popover-keep
              onClick={(e) => {
                e.stopPropagation();
                setSwitcher(switcher ? null : e.currentTarget.getBoundingClientRect());
              }}
            >
              <Icon name="chevronDown" size={16} />
            </button>
            <Icon name="chevronRight" size={18} className="mini__go" />
          </div>
          <div className="check-mini">
            {rows.slice(0, 7).map(({ task, num, depth }) => (
              <div key={task.id} className={`check-mini__row ${task.done ? 'is-done' : ''}`} style={{ paddingLeft: depth * 16 }}>
                <span className="check-mini__num">{num}</span>
                <span className={`check-mini__box ${task.done ? 'is-on' : ''}`}>{task.done && <Icon name="check" size={11} stroke={3.5} />}</span>
                <span className="check-mini__name">{task.name}</span>
                {task.role && <span className="chip">{task.role}</span>}
              </div>
            ))}
            {rows.length > 7 && <div className="check-mini__more">{t('home.moreItems', { n: rows.length - 7 })}</div>}
            {rows.length === 0 && <div className="check-mini__empty">{t('home.emptyBoard')}</div>}
          </div>
          {board && rows.length > 0 && (
            <div className="check-mini__progress">
              <div style={{ width: `${(board.doneCount / Math.max(1, board.taskCount)) * 100}%` }} />
            </div>
          )}
        </div>
      </section>

      <DailyBoard items={items} now={now} />

      {switcher && (
        <Popover anchor={switcher} onClose={() => setSwitcher(null)} className="menu-pop">
          <div className="menu">
            <div className="menu-label">{t('board.myBoards')}</div>
            {boards.map((b) => (
              <button
                key={b.id}
                className={`menu-item ${b.id === boardId ? 'is-on' : ''}`}
                onClick={() => {
                  api.updateSettings({ lastBoardId: b.id });
                  setSwitcher(null);
                }}
              >
                <Icon name="list" size={15} />
                <span className="menu-item__text">{b.name}</span>
                <span className="faint small">
                  {b.doneCount}/{b.taskCount}
                </span>
              </button>
            ))}
            <div className="menu-sep" />
            <button className="menu-item" onClick={newBoard}>
              <Icon name="plus" size={15} /> {t('board.newBoard')}
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}
