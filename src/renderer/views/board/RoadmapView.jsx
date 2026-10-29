// Roadmap view: a winding road read from the bottom (first task) to the top
// (the goal). The user's pet grows up along it: a newborn at the start, a
// little bigger at each milestone, and fully grown at the finish.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useBun, useIsMobile } from '../../store.jsx';
import { Icon } from '../../icons.jsx';
import { SPRITES, spriteUrl } from '../../sprite.jsx';
import { TaskEditor, Assignees } from '../../components/TaskFields.jsx';
import { fmtRange } from '../../../core/time.js';
import { numberTasks } from './tree.js';

const STEP = 132; // vertical distance between milestones
const TOP_SPACE = 250; // room for the grown-up pet, the board name and "add step"

// Timed tasks in chronological order, then the ones without a time.
export function roadmapSteps(tasks) {
  const rows = numberTasks(tasks).filter((r) => r.task.name);
  const timed = rows.filter((r) => r.task.start).sort((a, b) => a.task.start.localeCompare(b.task.start));
  const untimed = rows.filter((r) => !r.task.start);
  return [...timed, ...untimed];
}

// Growth frames from the sprite (newborn -> adult); older sprite files only have "sit".
function growthFrames(animal) {
  const s = SPRITES[animal];
  return s.stages?.length ? s.stages : [s.animations.sit.seq[0][0]];
}

export default function RoadmapView({ board, active }) {
  const { t, lang, user } = useBun();
  const mobile = useIsMobile();
  const scrollRef = useRef(null);
  const [width, setWidth] = useState(900);
  const [editor, setEditor] = useState(null);
  const steps = roadmapSteps(board.tasks);
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

  const n = steps.length;
  const H = TOP_SPACE + (n + 1) * STEP + 120;
  // Phones: the road runs down the left, cards fill the right.
  const cx = mobile ? 34 : width / 2;
  const amp = mobile ? 0 : Math.min(150, width * 0.16);
  const startPt = { x: cx, y: H - 110 };
  const points = steps.map((_, i) => ({ x: i % 2 === 0 ? cx - amp : cx + amp, y: startPt.y - (i + 1) * STEP }));
  const goalPt = { x: cx, y: startPt.y - (n + 1) * STEP };
  const all = [startPt, ...points, goalPt];

  const pathThrough = (pts) =>
    pts.reduce((d, p, i) => {
      if (i === 0) return `M ${p.x} ${p.y}`;
      const q = pts[i - 1];
      return `${d} C ${q.x} ${q.y - STEP * 0.55}, ${p.x} ${p.y + STEP * 0.55}, ${p.x} ${p.y}`;
    }, '');

  let doneRun = 0;
  while (doneRun < n && steps[doneRun].task.done) doneRun++;
  const allDone = n > 0 && steps.every((s) => s.task.done);
  const cardW = mobile ? Math.max(180, width - cx - 46) : Math.max(170, Math.min(280, cx - amp - 52));

  const frames = growthFrames(user.animal);
  const adult = frames[frames.length - 1];
  // Milestones walk through every stage except the adult, which waits at the goal.
  const stageFor = (i) => (frames.length < 2 ? frames[0] : frames[Math.min(frames.length - 2, Math.floor(((i + 1) / (n + 1)) * (frames.length - 1)))]);

  return (
    <div className={`roadmap ${active ? 'is-active' : ''} ${mobile ? 'roadmap--mobile' : ''}`} ref={scrollRef}>
      <div className="roadmap__canvas" style={{ height: H, margin: `0 ${margin}px` }}>
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
          <button className="btn btn--sm roadmap__add" onClick={(e) => setEditor({ anchor: e.currentTarget.getBoundingClientRect() })}>
            <Icon name="plus" size={15} /> {t('board.addStep')}
          </button>
        </div>

        {steps.map(({ task, num }, i) => {
          const p = points[i];
          const left = !mobile && p.x < cx;
          const parent = task.parentId && byId.get(task.parentId);
          return (
            <div key={task.id} className="roadmap__step" style={{ left: p.x, top: p.y, '--i': n - i }}>
              <div className={`roadmap__node ${task.done ? 'is-done' : ''} ${task.start ? '' : 'is-untimed'}`}>
                <img src={spriteUrl(user.animal, stageFor(i))} alt="" className="roadmap__pet" draggable={false} />
                <span className="roadmap__badge">{task.done ? <Icon name="check" size={11} stroke={3.2} /> : i + 1}</span>
              </div>
              <button
                className={`roadmap__card ${left ? 'is-left' : 'is-right'} ${task.done ? 'is-done' : ''}`}
                style={{ width: cardW }}
                onClick={(e) => setEditor({ anchor: e.currentTarget.getBoundingClientRect(), task })}
              >
                <span className="roadmap__num">{num}</span>
                <span className="roadmap__name">{task.name}</span>
                {parent?.name && <span className="roadmap__parent">↳ {parent.name}</span>}
                <span className="roadmap__meta">
                  {task.start ? (
                    <span className="roadmap__time">
                      <Icon name="clock" size={12} /> {fmtRange(task.start, task.end, lang)}
                    </span>
                  ) : (
                    <span className="faint">{t('board.roadmapUntimed')}</span>
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
