// Mindmap view of a board: the board is the big dot on top, tasks hang below
// it, subtasks below them. Click a dot to grow a new branch under it; click a
// label to fill in name, time, role and assignees. Styled like the rest of the
// app: light cards on a dotted canvas, one soft colour per main branch.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useBun } from '../../store.jsx';
import { Icon } from '../../icons.jsx';
import { PetAvatar } from '../../sprite.jsx';
import { Popover } from '../../components/Popover.jsx';
import { TaskEditor, Assignees } from '../../components/TaskFields.jsx';
import { fmtRange } from '../../../core/time.js';
import { childrenMap } from './tree.js';

const GAP_X = 230;
const GAP_Y = 150;
const DOT = { 0: 64, 1: 30, 2: 22 };
// Branch colours (CSS variables defined in app.css so dark mode can adjust them).
const BRANCHES = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];

// Simple tidy tree: leaves get consecutive x slots, parents sit above the
// middle of their children. The root (the board itself) is at depth 0.
function layoutTree(tasks) {
  const kids = childrenMap(tasks);
  const nodes = [];
  const edges = [];
  let leaf = 0;
  const place = (task, depth, branch) => {
    const children = kids.get(task ? task.id : null) || [];
    const placed = children.map((c, i) => place(c, depth + 1, depth === 0 ? BRANCHES[i % BRANCHES.length] : branch));
    const x = placed.length ? (placed[0].x + placed[placed.length - 1].x) / 2 : leaf++ * GAP_X;
    const node = { id: task ? task.id : 'root', task, depth, branch, x, y: depth * GAP_Y, size: DOT[Math.min(depth, 2)] };
    nodes.push(node);
    for (const p of placed) edges.push({ from: node, to: p });
    return node;
  };
  place(null, 0, 'root');
  return { nodes, edges };
}

// A soft S-curve from the bottom of the parent dot to the top of the child dot.
function edgePath(a, b) {
  const y1 = a.y + a.size / 2;
  const y2 = b.y - b.size / 2;
  const my = (y1 + y2) / 2;
  return `M ${a.x} ${y1} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${y2}`;
}

export default function MindmapView({ board, active }) {
  const { t, lang, run, user } = useBun();
  const viewRef = useRef(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [editor, setEditor] = useState(null);
  const [rename, setRename] = useState(null);
  const fitted = useRef(false);
  const known = useRef(null);

  const { nodes, edges } = useMemo(() => layoutTree(board.tasks), [board.tasks]);

  // Remember which nodes existed on first render so only new ones animate in.
  if (known.current === null) known.current = new Set(nodes.map((n) => n.id));
  const isNew = (id) => !known.current.has(id);
  useEffect(() => {
    const id = setTimeout(() => nodes.forEach((n) => known.current.add(n.id)), 700);
    return () => clearTimeout(id);
  }, [nodes]);

  const fit = useCallback(() => {
    const el = viewRef.current;
    if (!el) return;
    const W = el.clientWidth;
    const H = el.clientHeight;
    const minX = Math.min(...nodes.map((n) => n.x)) - 60;
    const maxX = Math.max(...nodes.map((n) => n.x)) + 220;
    const maxY = Math.max(...nodes.map((n) => n.y)) + 90;
    const k = Math.max(0.45, Math.min(1.1, (W - 60) / (maxX - minX), (H - 120) / (maxY + 80)));
    setView({ k, x: W / 2 - ((minX + maxX) / 2) * k, y: 80 });
  }, [nodes]);

  useLayoutEffect(() => {
    if (active && !fitted.current) {
      fitted.current = true;
      fit();
    }
  }, [active, fit]);

  // Pan with one finger / the mouse, pinch or wheel to zoom.
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('.mm-node, .mm-tools')) return;
    viewRef.current.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    viewRef.current.classList.add('is-panning');
    gesture.current = { view, pts: [...pointers.current.values()].map((p) => ({ ...p })) };
  };
  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (pts.length === 1 && g.pts.length === 1) {
      setView({ ...g.view, x: g.view.x + pts[0].x - g.pts[0].x, y: g.view.y + pts[0].y - g.pts[0].y });
    } else if (pts.length >= 2 && g.pts.length >= 2) {
      const r = viewRef.current.getBoundingClientRect();
      const d0 = Math.hypot(g.pts[0].x - g.pts[1].x, g.pts[0].y - g.pts[1].y);
      const d1 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const c0 = { x: (g.pts[0].x + g.pts[1].x) / 2 - r.left, y: (g.pts[0].y + g.pts[1].y) / 2 - r.top };
      const c1 = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
      const k = Math.max(0.3, Math.min(2, g.view.k * (d1 / d0)));
      setView({ k, x: c1.x - ((c0.x - g.view.x) / g.view.k) * k, y: c1.y - ((c0.y - g.view.y) / g.view.k) * k });
    }
  };
  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      viewRef.current?.classList.remove('is-panning');
      gesture.current = null;
    } else gesture.current = { view, pts: [...pointers.current.values()].map((p) => ({ ...p })) };
  };

  useEffect(() => {
    const el = viewRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setView((v) => {
        const k = Math.max(0.3, Math.min(2, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Keep the clicked dot still on screen while the tree re-flows around it.
  const anchor = useRef(null);
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    const n = nodes.find((x) => x.id === a.id);
    if (!n || (n.x === a.x && n.y === a.y)) return;
    anchor.current = { id: n.id, x: n.x, y: n.y };
    setView((v) => ({ ...v, x: v.x - (n.x - a.x) * v.k, y: v.y - (n.y - a.y) * v.k }));
  }, [nodes]);

  const grow = (node) => {
    anchor.current = { id: node.id, x: node.x, y: node.y };
    run(api.createTask({ boardId: board.id, parentId: node.task ? node.task.id : null, name: '' }));
  };

  const openLabel = (node, e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!node.task) {
      if (board.canManage) setRename({ anchor: rect, name: board.name });
      return;
    }
    setEditor({ anchor: rect, task: node.task });
  };

  return (
    <div className="mindmap" ref={viewRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <div className="mm-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="mm-lines">
          {edges.map(({ from, to }) => (
            <path key={to.id} d={edgePath(from, to)} pathLength="1" className={`mm-edge mm-c-${to.branch} ${isNew(to.id) ? 'is-new' : ''}`} />
          ))}
        </svg>
        {nodes.map((node) => {
          const task = node.task;
          const empty = task && !task.name;
          const d = Math.min(node.depth, 2);
          return (
            <div key={node.id} className={`mm-node mm-node--d${d} mm-c-${node.branch} ${isNew(node.id) ? 'is-new' : ''} ${task?.done ? 'is-done' : ''}`} style={{ left: node.x, top: node.y }}>
              <button className="mm-dot" style={{ width: node.size, height: node.size }} onClick={() => grow(node)} title={t('board.mindmapGrow')}>
                {node.depth === 0 ? (
                  <PetAvatar animal={user.animal} size={44} className="mm-dot__pet" />
                ) : task?.done ? (
                  <Icon name="check" size={node.size * 0.5} stroke={3} />
                ) : (
                  <Icon name="plus" size={node.size * 0.5} stroke={2.6} className="mm-dot__plus" />
                )}
              </button>
              <div className="mm-label" style={{ left: node.size / 2 + 12 }}>
                <button className={`mm-label__main ${empty ? 'is-empty' : ''}`} onClick={(e) => openLabel(node, e)}>
                  <span className="mm-label__name">{task ? task.name || t('board.mindmapEmpty') : board.name}</span>
                  {task && (task.start || task.role) && (
                    <span className="mm-label__meta">
                      {task.start && (
                        <span className="mm-label__time">
                          <Icon name="clock" size={11} /> {fmtRange(task.start, task.end, lang)}
                        </span>
                      )}
                      {task.role && <span className="chip">{task.role}</span>}
                    </span>
                  )}
                  {task?.assigneeUsers?.length > 0 && (
                    <span className="mm-label__people">
                      <Assignees users={task.assigneeUsers} size={18} />
                      <span>{task.assigneeUsers.map((u) => u.name).join(', ')}</span>
                    </span>
                  )}
                </button>
                {task && (board.canManage || task.createdBy === user.id) && (
                  <button className="mm-label__del" onClick={() => run(api.deleteTask(task.id))} title={t('task.delete')}>
                    <Icon name="x" size={13} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mm-tools">
        <span className="mm-tools__hint">{t('board.mindmapHint')}</span>
        <button className="mm-tools__btn" onClick={fit} title={t('board.fit')}>
          <Icon name="target" size={16} />
        </button>
      </div>

      {editor && <TaskEditor key={editor.task.id} anchor={editor.anchor} task={editor.task} board={board} placement="right" onClose={() => setEditor(null)} />}
      {rename && <RenamePop board={board} anchor={rename.anchor} onClose={() => setRename(null)} />}
    </div>
  );
}

function RenamePop({ board, anchor, onClose }) {
  const { t, run } = useBun();
  const [name, setName] = useState(board.name);
  const save = () => {
    if (name.trim() && name !== board.name) run(api.renameBoard(board.id, name));
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={save} placement="right">
      <span className="label">{t('home.checklist')}</span>
      <input className="input input--sm" value={name} autoFocus maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
    </Popover>
  );
}
