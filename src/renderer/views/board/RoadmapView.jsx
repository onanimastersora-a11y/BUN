// Roadmap view: a winding road read from the bottom (first task) to the top
// (the goal). The user's pet grows up along it: a newborn at the start, a
// little bigger at each milestone, and fully grown at the finish.
// Steps follow their deadlines until the user drags one up or down the road;
// from then on the board keeps that order ("Sort by deadline" goes back).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useBun, useIsMobile, useNow } from '../../store.jsx';
import { Icon } from '../../icons.jsx';
import { SPRITES, spriteUrl } from '../../sprite.jsx';
import { TaskEditor, Assignees } from '../../components/TaskFields.jsx';
import { fmtDue } from '../../../core/time.js';
import { isOverdue, roadmapSteps } from './tree.js';
import '../../styles/board-dnd.css';

const STEP = 132; // vertical distance between milestones
const TOP_SPACE = 250; // room for the grown-up pet, the board name and "add step"
const EDGE = 70; // auto-scroll when a dragged step is this close to the top/bottom
const LONG_PRESS = 320; // ms a finger rests on a card before it lifts

// Growth frames from the sprite (newborn -> adult); older sprite files only have "sit".
function growthFrames(animal) {
  const s = SPRITES[animal];
  return s.stages?.length ? s.stages : [s.animations.sit.seq[0][0]];
}

export default function RoadmapView({ board, active }) {
  const { t, lang, run, user } = useBun();
  const mobile = useIsMobile();
  const now = useNow(60000).getTime();
  const scrollRef = useRef(null);
  const canvasRef = useRef(null);
  const [width, setWidth] = useState(900);
  const [editor, setEditor] = useState(null);
  const [drag, setDrag] = useState(null); // { id, x, y, target }
  const [sorting, setSorting] = useState(false); // steps glide to new slots
  // An order we saved that hasn't come back yet ('due' = back to deadline order).
  const [pending, setPending] = useState(null);
  const savedKey = JSON.stringify(board.roadmapOrder || null);
  useEffect(() => setPending(null), [savedKey]);
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => setPending(null), 3000);
    return () => clearTimeout(id);
  }, [pending]);

  const order = pending === 'due' ? null : pending || board.roadmapOrder;
  const steps = roadmapSteps(board.tasks, order);
  const byId = new Map(board.tasks.map((x) => [x.id, x]));
  const margin = mobile ? 12 : 70;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - margin * 2));
    ro.observe(el);
    return () => ro.disconnect();
  }, [margin]);

  // Start at the bottom: the journey begins with the earliest task.
  useEffect(() => {
    if (active && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [active]);

  // Fingers: once a step is lifted, the page must not scroll under it. This
  // listener is always there so the browser knows it may block scrolling.
  const lifted = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    const block = (e) => lifted.current && e.cancelable && e.preventDefault();
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  }, []);

  const sortTimer = useRef(0);
  const glide = () => {
    clearTimeout(sortTimer.current);
    setSorting(true);
    sortTimer.current = setTimeout(() => setSorting(false), 320);
  };
  useEffect(() => () => clearTimeout(sortTimer.current), []);

  const n = steps.length;
  const H = TOP_SPACE + (n + 1) * STEP + 120;
  // Phones: the road runs down the left, cards fill the right.
  const cx = mobile ? 34 : width / 2;
  const amp = mobile ? 0 : Math.min(150, width * 0.16);
  const startPt = { x: cx, y: H - 110 };
  const points = steps.map((_, i) => ({ x: i % 2 === 0 ? cx - amp : cx + amp, y: startPt.y - (i + 1) * STEP }));
  const goalPt = { x: cx, y: startPt.y - (n + 1) * STEP };
  const all = [startPt, ...points, goalPt];

  // While dragging, the other steps make room at the drop slot.
  let shown = steps;
  if (drag) {
    const me = steps.find((s) => s.task.id === drag.id);
    if (me) {
      shown = steps.filter((s) => s !== me);
      shown.splice(drag.target, 0, me);
    }
  }

  const live = useRef({});
  live.current = { steps, points, startY: startPt.y, cx, mobile };

  const pathThrough = (pts) =>
    pts.reduce((d, p, i) => {
      if (i === 0) return `M ${p.x} ${p.y}`;
      const q = pts[i - 1];
      return `${d} C ${q.x} ${q.y - STEP * 0.55}, ${p.x} ${p.y + STEP * 0.55}, ${p.x} ${p.y}`;
    }, '');

  let doneRun = 0;
  while (doneRun < n && shown[doneRun].task.done) doneRun++;
  const allDone = n > 0 && steps.every((s) => s.task.done);
  const cardW = mobile ? Math.max(180, width - cx - 46) : Math.max(170, Math.min(280, cx - amp - 52));

  const frames = growthFrames(user.animal);
  const adult = frames[frames.length - 1];
  // Milestones walk through every stage except the adult, which waits at the goal.
  const stageFor = (i) => (frames.length < 2 ? frames[0] : frames[Math.min(frames.length - 2, Math.floor(((i + 1) / (n + 1)) * (frames.length - 1)))]);

  // ---------- dragging a step ----------

  const busy = useRef(false);
  const suppressClick = useRef(false);

  const press = (e, task, part) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || busy.current) return;
    const index = steps.findIndex((s) => s.task.id === task.id);
    if (index < 0) return;
    busy.current = true;
    const pid = e.pointerId;
    const el = e.currentTarget;
    // A finger on a card waits for a long press, so a swipe still scrolls the road.
    const waitForHold = e.pointerType === 'touch' && part === 'card';
    const start = { x: e.clientX, y: e.clientY };
    const local = (x, y) => {
      const r = canvasRef.current.getBoundingClientRect();
      return { x: x - r.left, y: y - r.top };
    };
    const g0 = local(start.x, start.y);
    const p0 = points[index];
    const offset = { x: g0.x - p0.x, y: g0.y - p0.y };
    let last = start;
    let activeDrag = false;
    let raf = 0;
    let timer = 0;

    const aim = () => {
      const g = live.current;
      const c = local(last.x, last.y);
      const y = c.y - offset.y;
      const target = Math.max(0, Math.min(g.steps.length - 1, Math.round((g.startY - y) / STEP) - 1));
      return { id: task.id, x: g.mobile ? g.cx : c.x - offset.x, y, target };
    };

    const frame = () => {
      raf = 0;
      const sc = scrollRef.current;
      let scrolled = false;
      if (sc) {
        const r = sc.getBoundingClientRect();
        const top = Math.max(r.top, 0) + EDGE;
        const bottom = Math.min(r.bottom, window.innerHeight) - EDGE;
        const speed = last.y < top ? -(top - last.y) : last.y > bottom ? last.y - bottom : 0;
        if (speed) {
          const before = sc.scrollTop;
          sc.scrollTop += Math.max(-20, Math.min(20, Math.round((speed / EDGE) * 18)));
          scrolled = sc.scrollTop !== before;
        }
      }
      setDrag(aim());
      if (scrolled) raf = requestAnimationFrame(frame);
    };

    const begin = () => {
      activeDrag = true;
      lifted.current = true;
      suppressClick.current = true;
      try {
        el.setPointerCapture(pid);
      } catch {}
      if (waitForHold) navigator.vibrate?.(8);
      clearTimeout(sortTimer.current);
      setSorting(true);
      setDrag(aim());
    };

    const stop = () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', noMenu, true);
      busy.current = false;
      lifted.current = false;
      setTimeout(() => (suppressClick.current = false), 0);
    };

    const finish = (cancel) => {
      stop();
      if (!activeDrag) return;
      const a = aim();
      const current = live.current.steps.map((s) => s.task.id);
      setDrag(null); // the step glides from the pointer into its slot
      glide();
      if (cancel) return;
      const ids = current.filter((id) => id !== task.id);
      ids.splice(a.target, 0, task.id);
      if (ids.join() === current.join()) return;
      setPending(ids);
      run(api.setRoadmapOrder(board.id, ids)).catch(() => setPending(null));
    };

    const onMove = (ev) => {
      if (ev.pointerId !== pid) return;
      last = { x: ev.clientX, y: ev.clientY };
      if (!activeDrag) {
        const dist = Math.hypot(last.x - start.x, last.y - start.y);
        if (waitForHold) {
          if (dist > 8) stop(); // a swipe: let the road scroll
          return;
        }
        if (dist < 5) return;
        begin();
      }
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const onUp = (ev) => ev.pointerId === pid && finish(ev.type === 'pointercancel');
    const onKey = (ev) => {
      if (ev.key !== 'Escape' || !activeDrag) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(true);
    };
    const noMenu = (ev) => ev.preventDefault();
    if (waitForHold) timer = setTimeout(begin, LONG_PRESS);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
    if (e.pointerType === 'touch') window.addEventListener('contextmenu', noMenu, true);
  };

  const sortByDeadline = () => {
    glide();
    setPending('due');
    run(api.setRoadmapOrder(board.id, null)).catch(() => setPending(null));
  };

  const openStep = (e, task) => {
    if (suppressClick.current) return;
    setEditor({ anchor: e.currentTarget.getBoundingClientRect(), task });
  };

  return (
    <div className={`roadmap ${active ? 'is-active' : ''} ${mobile ? 'roadmap--mobile' : ''} ${sorting ? 'is-sorting' : ''}`} ref={scrollRef}>
      <div className="roadmap__canvas" ref={canvasRef} style={{ height: H, margin: `0 ${margin}px` }}>
        <svg className="roadmap__svg" width={width} height={H}>
          <path d={pathThrough(all)} className="roadmap__road" />
          <path d={pathThrough(all)} className="roadmap__dash" />
          {doneRun > 0 && <path d={pathThrough(all.slice(0, doneRun + 1))} className="roadmap__progress" />}
        </svg>

        <div className={`roadmap__goal ${allDone ? 'is-done' : ''}`} style={{ left: goalPt.x, top: goalPt.y }}>
          <div className="roadmap__goal-stage">
            {allDone && <span className="roadmap__sparkles" aria-hidden="true">✦ ✧ ✦</span>}
            <img src={spriteUrl(user.animal, adult)} alt="" className="roadmap__pet roadmap__pet--adult" draggable={false} />
          </div>
          <div className="roadmap__goal-label">{allDone ? t('board.roadmapDone') : t('board.roadmapGoal')}</div>
          <div className="roadmap__goal-name">{board.name}</div>
          <div className="roadmap__goal-actions">
            <button className="btn btn--sm roadmap__add" onClick={(e) => setEditor({ anchor: e.currentTarget.getBoundingClientRect() })}>
              <Icon name="plus" size={15} /> {t('board.addStep')}
            </button>
            {order && (
              <button className="btn btn--sm btn--ghost roadmap__sort" onClick={sortByDeadline}>
                <Icon name="flag" size={14} /> {t('board.sortByDue')}
              </button>
            )}
          </div>
        </div>

        {drag && points[drag.target] && <div className="roadmap__slot" style={{ left: points[drag.target].x, top: points[drag.target].y }} />}

        {shown.map(({ task, num }, i) => {
          const dragging = drag?.id === task.id;
          const p = dragging ? { x: drag.x, y: drag.y } : points[i];
          const side = dragging ? points[steps.findIndex((s) => s.task.id === task.id)] : points[i];
          const left = !mobile && side.x < cx;
          const parent = task.parentId && byId.get(task.parentId);
          const late = isOverdue(task, now);
          return (
            <div key={task.id} className={`roadmap__step ${dragging ? 'is-dragging' : ''}`} style={{ left: p.x, top: p.y, '--i': n - i }}>
              <div className={`roadmap__node ${task.done ? 'is-done' : ''} ${task.due ? '' : 'is-untimed'}`} onPointerDown={(e) => press(e, task, 'node')} title={t('board.dragHint')}>
                <img src={spriteUrl(user.animal, stageFor(i))} alt="" className="roadmap__pet" draggable={false} />
                <span className="roadmap__badge">{task.done ? <Icon name="check" size={11} stroke={3.2} /> : i + 1}</span>
              </div>
              <button
                className={`roadmap__card ${left ? 'is-left' : 'is-right'} ${task.done ? 'is-done' : ''}`}
                style={{ width: cardW }}
                onPointerDown={(e) => press(e, task, 'card')}
                onClick={(e) => openStep(e, task)}
              >
                <span className="roadmap__num">{num}</span>
                <span className="roadmap__name">{task.name}</span>
                {parent?.name && <span className="roadmap__parent">↳ {parent.name}</span>}
                <span className="roadmap__meta">
                  {task.due ? (
                    <span className={`roadmap__time ${late ? 'is-overdue' : ''}`} title={late ? t('board.overdue') : t('task.due')}>
                      <Icon name="flag" size={12} /> {fmtDue(task.due, lang)}
                    </span>
                  ) : (
                    <span className="faint">{t('board.roadmapNoDue')}</span>
                  )}
                  {task.role && <span className="chip">{task.role}</span>}
                  <Assignees users={task.assigneeUsers} size={20} />
                </span>
              </button>
            </div>
          );
        })}

        <div className="roadmap__start" style={{ left: startPt.x, top: startPt.y }}>
          <div className="roadmap__start-stage">
            <img src={spriteUrl(user.animal, frames[0])} alt="" className="roadmap__pet" draggable={false} />
          </div>
          <span>{t('board.roadmapStart')}</span>
        </div>
      </div>

      {editor && (
        <TaskEditor
          key={editor.task?.id || 'new'}
          anchor={editor.anchor}
          task={editor.task}
          draft={{ boardId: board.id }}
          board={board}
          placement={mobile ? 'bottom' : 'right'}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
