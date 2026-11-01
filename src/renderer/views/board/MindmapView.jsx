// Mindmap view of a board: the board is the big dot on top, tasks hang below
// it, subtasks below them. Click a dot to grow a new branch under it; click a
// label to fill in name, deadline, role and assignees; drag a dot (or its
// label) next to another dot to hang it, and its branch, under that dot.
// Styled like the rest of the app: light cards on a dotted canvas, one soft
// colour per main branch.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useBun, useNow } from '../../store.jsx';
import { Icon } from '../../icons.jsx';
import { PetAvatar } from '../../sprite.jsx';
import { Popover } from '../../components/Popover.jsx';
import { TaskEditor, Assignees } from '../../components/TaskFields.jsx';
import { fmtDue } from '../../../core/time.js';
import { childrenMap, isOverdue, samePlace, subtreeIds } from './tree.js';
import '../../styles/board-dnd.css';

const GAP_X = 230;
const GAP_Y = 150;
const DOT = { 0: 64, 1: 30, 2: 22 };
// Branch colours (CSS variables defined in app.css so dark mode can adjust them).
const BRANCHES = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
// Dragging: a new parent must be at least ABOVE layout px higher and within NEAR.
const ABOVE = 20;
const NEAR = 240;
const DRAG_START = 5; // screen px of movement before a press becomes a drag
const SETTLE_MS = 240;
const EDGE = 44; // auto-pan when the pointer is this close to the canvas edge
const easeOut = (x) => 1 - Math.pow(1 - x, 3);

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
    const node = { id: task ? task.id : 'root', task, depth, branch, x, y: depth * GAP_Y, size: DOT[Math.min(depth, 2)], kids: placed };
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

// The dot a dragged dot at `p` would hang from: the nearest one above it,
// outside the dragged branch. The root counts (it means "top level").
function findParent(nodes, p, skip) {
  let best = null;
  let bestD = NEAR;
  for (const n of nodes) {
    if (skip.has(n.id) || n.y > p.y - ABOVE) continue;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d <= bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

export default function MindmapView({ board, active }) {
  const { t, lang, run, user } = useBun();
  const now = useNow(60000).getTime();
  const viewRef = useRef(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [editor, setEditor] = useState(null);
  const [rename, setRename] = useState(null);
  const [drag, setDrag] = useState(null); // { id, subtree, dx, dy, parent, beforeId, dropping }
  const [settle, setSettle] = useState(null); // { from: Map(id -> {x, y}), t } after a drop
  const fitted = useRef(false);
  const known = useRef(null);

  const { nodes, edges } = useMemo(() => layoutTree(board.tasks), [board.tasks]);
  // Tree shape; changes once a move has come back from the backend.
  const shape = board.tasks.map((x) => `${x.id}:${x.parentId || ''}:${x.order}`).join('|');
  const live = useRef({});
  live.current = { nodes, view, tasks: board.tasks, shape };

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

  // ---------- dragging a dot ----------

  const settleRaf = useRef(0);
  const pending = useRef(null); // a drop waiting for the backend
  const dragCtl = useRef(null); // the live drag, so a zoom/pan can re-aim it
  const suppressClick = useRef(false);

  // Glide every dot from `from` (layout positions) to where the layout puts it.
  const startSettle = useCallback((from) => {
    cancelAnimationFrame(settleRaf.current);
    const t0 = performance.now();
    setSettle({ from, t: 0 });
    const tick = (time) => {
      const p = Math.min(1, (time - t0) / SETTLE_MS);
      setSettle((s) => (s && s.from === from ? (p >= 1 ? null : { from, t: p }) : s));
      if (p < 1) settleRaf.current = requestAnimationFrame(tick);
    };
    settleRaf.current = requestAnimationFrame(tick);
  }, []);
  useEffect(() => () => cancelAnimationFrame(settleRaf.current), []);

  // The move came back: the tree has its new shape. Glide from the drop spot.
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p || p.shape === shape) return;
    pending.current = null;
    // The anchor effect above keeps the new parent still on screen by moving
    // the view; shift the start positions the same way so nothing jumps.
    const a = nodes.find((n) => n.id === p.anchorId);
    const sx = a ? a.x - p.anchorAt.x : 0;
    const sy = a ? a.y - p.anchorAt.y : 0;
    setDrag(null);
    startSettle(new Map([...p.from].map(([id, q]) => [id, { x: q.x + sx, y: q.y + sy }])));
  }, [shape]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    dragCtl.current?.refresh();
  }, [view]);

  useEffect(() => {
    document.body.classList.toggle('is-mm-dragging', !!drag && !drag.dropping);
    return () => document.body.classList.remove('is-mm-dragging');
  }, [!!drag && !drag.dropping]); // eslint-disable-line react-hooks/exhaustive-deps

  const press = (e, node) => {
    if (!node.task || (e.pointerType === 'mouse' && e.button !== 0) || dragCtl.current || pending.current) return;
    const id = node.id;
    const pid = e.pointerId;
    const el = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    const toLayout = (x, y) => {
      const r = viewRef.current.getBoundingClientRect();
      const v = live.current.view;
      return { x: (x - r.left - v.x) / v.k, y: (y - r.top - v.y) / v.k };
    };
    const grab = toLayout(start.x, start.y);
    const subtree = subtreeIds(board.tasks, id);
    let last = start;
    let active = false;
    let raf = 0;

    // Where the dragged dot is now, and which dot it would hang from.
    const aim = () => {
      const { nodes: list } = live.current;
      const self = list.find((n) => n.id === id);
      if (!self) return null;
      const L = toLayout(last.x, last.y);
      const dx = L.x - grab.x + (node.x - self.x);
      const dy = L.y - grab.y + (node.y - self.y);
      const p = { x: self.x + dx, y: self.y + dy };
      const parent = findParent(list, p, subtree);
      // Keep left-to-right order: go before the first child to the right of the drop.
      const next = parent?.kids.find((k) => k.id !== id && k.x > p.x);
      return { self, dx, dy, p, parent, beforeId: next ? next.id : null };
    };
    const publish = () => {
      const a = aim();
      if (!a) return;
      setDrag((d) => ({ id, subtree, dx: a.dx, dy: a.dy, parent: a.parent, beforeId: a.beforeId, dropping: d?.dropping || false }));
    };

    const frame = () => {
      raf = 0;
      // Pan the canvas when the pointer nears its edge.
      const r = viewRef.current.getBoundingClientRect();
      const push = (v, lo, hi) => (v < lo + EDGE ? Math.min(12, (lo + EDGE - v) / 3) : v > hi - EDGE ? -Math.min(12, (v - (hi - EDGE)) / 3) : 0);
      const px = push(last.x, r.left, r.right);
      const py = push(last.y, r.top, r.bottom);
      if (px || py) {
        setView((v) => ({ ...v, x: v.x + px, y: v.y + py }));
        raf = requestAnimationFrame(frame);
      }
      publish();
    };

    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
      cancelAnimationFrame(raf);
      dragCtl.current = null;
      setTimeout(() => (suppressClick.current = false), 0);
    };

    const finish = (cancel) => {
      stop();
      if (!active) return;
      const a = aim();
      const { nodes: list, tasks, shape: at } = live.current;
      // Where every dot is on screen right now (layout coords).
      const from = new Map(list.map((n) => [n.id, subtree.has(n.id) && a ? { x: n.x + a.dx, y: n.y + a.dy } : { x: n.x, y: n.y }]));
      const parentId = a?.parent?.task ? a.parent.task.id : null;
      const task = tasks.find((x) => x.id === id);
      if (cancel || !a || !a.parent || !task || samePlace(tasks, task, parentId, a.beforeId)) {
        setDrag(null);
        startSettle(from);
        return;
      }
      const token = {};
      pending.current = { token, shape: at, from, anchorId: a.parent.id, anchorAt: { x: a.parent.x, y: a.parent.y } };
      anchor.current = { id: a.parent.id, x: a.parent.x, y: a.parent.y };
      setDrag((d) => d && { ...d, dropping: true });
      const back = () => {
        if (pending.current?.token !== token) return;
        pending.current = null;
        setDrag(null);
        startSettle(from);
      };
      run(api.moveTask(id, { parentId, beforeId: a.beforeId })).catch(back);
      setTimeout(back, 2500);
    };

    const onMove = (ev) => {
      if (ev.pointerId !== pid) return;
      last = { x: ev.clientX, y: ev.clientY };
      if (!active) {
        if (Math.hypot(last.x - start.x, last.y - start.y) < DRAG_START) return;
        active = true;
        suppressClick.current = true;
        try {
          el.setPointerCapture(pid);
        } catch {}
        cancelAnimationFrame(settleRaf.current);
        setSettle(null);
        dragCtl.current = { refresh: publish };
      }
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const onUp = (ev) => ev.pointerId === pid && finish(ev.type === 'pointercancel');
    const onKey = (ev) => {
      if (ev.key !== 'Escape' || !active) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
  };

  // Where each dot is drawn: dragged ones follow the pointer, the rest glide
  // into place after a drop.
  const shown = new Map(
    nodes.map((n) => {
      if (drag?.subtree.has(n.id)) return [n.id, { ...n, x: n.x + drag.dx, y: n.y + drag.dy }];
      const f = settle?.from.get(n.id);
      if (f) {
        const e = easeOut(settle.t);
        return [n.id, { ...n, x: f.x + (n.x - f.x) * e, y: f.y + (n.y - f.y) * e }];
      }
      return [n.id, n];
    }),
  );
  const target = drag?.parent && shown.get(drag.id) ? shown.get(drag.parent.id) : null;

  const grow = (node) => {
    if (suppressClick.current) return;
    anchor.current = { id: node.id, x: node.x, y: node.y };
    run(api.createTask({ boardId: board.id, parentId: node.task ? node.task.id : null, name: '' }));
  };

  const openLabel = (node, e) => {
    if (suppressClick.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!node.task) {
      if (board.canManage) setRename({ anchor: rect, name: board.name });
      return;
    }
    setEditor({ anchor: rect, task: node.task });
  };

  return (
    <div
      className={`mindmap ${drag ? 'is-dragging' : ''}`}
      ref={viewRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="mm-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="mm-lines">
          {edges.map(({ from, to }) => (
            <path
              key={to.id}
              d={edgePath(shown.get(from.id), shown.get(to.id))}
              pathLength="1"
              className={`mm-edge mm-c-${to.branch} ${isNew(to.id) ? 'is-new' : ''} ${drag?.id === to.id ? 'is-detached' : ''}`}
            />
          ))}
          {target && <path d={edgePath(target, shown.get(drag.id))} className={`mm-edge mm-edge--preview mm-c-${target.branch}`} />}
        </svg>
        {nodes.map((node) => {
          const task = node.task;
          const empty = task && !task.name;
          const d = Math.min(node.depth, 2);
          const s = shown.get(node.id);
          const late = task && isOverdue(task, now);
          const dragCls = drag?.id === node.id ? 'is-dragging' : drag?.subtree.has(node.id) ? 'is-carried' : drag?.parent?.id === node.id ? 'is-drop-target' : '';
          return (
            <div
              key={node.id}
              className={`mm-node mm-node--d${d} mm-c-${node.branch} ${isNew(node.id) ? 'is-new' : ''} ${task?.done ? 'is-done' : ''} ${dragCls}`}
              style={{ left: s.x, top: s.y }}
            >
              <button
                className="mm-dot"
                style={{ width: node.size, height: node.size }}
                onPointerDown={(e) => press(e, node)}
                onClick={() => grow(node)}
                title={t('board.mindmapGrow')}
              >
                {node.depth === 0 ? (
                  <PetAvatar animal={user.animal} size={44} className="mm-dot__pet" />
                ) : task?.done ? (
                  <Icon name="check" size={node.size * 0.5} stroke={3} />
                ) : (
                  <Icon name="plus" size={node.size * 0.5} stroke={2.6} className="mm-dot__plus" />
                )}
              </button>
              <div className="mm-label" style={{ left: node.size / 2 + 12 }}>
                <button className={`mm-label__main ${empty ? 'is-empty' : ''}`} onPointerDown={(e) => press(e, node)} onClick={(e) => openLabel(node, e)}>
                  <span className="mm-label__name">{task ? task.name || t('board.mindmapEmpty') : board.name}</span>
                  {task && (task.due || task.role) && (
                    <span className="mm-label__meta">
                      {task.due && (
                        <span className={`mm-label__time ${late ? 'is-overdue' : ''}`} title={late ? t('board.overdue') : t('task.due')}>
                          <Icon name="flag" size={11} /> {fmtDue(task.due, lang)}
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
