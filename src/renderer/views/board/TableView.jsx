import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';
import { useBun, useNow } from '../../store.jsx';
import { Icon } from '../../icons.jsx';
import { Popover } from '../../components/Popover.jsx';
import { AssigneeList, Assignees, DeadlineField, RoleInput } from '../../components/TaskFields.jsx';
import { fmtDue } from '../../../core/time.js';
import { isOverdue, nextSiblingId, numberTasks, parentOf, samePlace, subtreeIds } from './tree.js';
import '../../styles/board-dnd.css';

const INDENT = 22; // px per tree level in the name column
const EDGE = 64; // auto-scroll when the pointer is this close to the top/bottom
const EASE = 'cubic-bezier(0.22, 0.8, 0.24, 1)';

// Where a dragged row would land, from the pointer's y over the rows.
// Top quarter of a row: before it. Bottom quarter: after it (after its
// subtree). Middle: last child of it. Never inside the dragged subtree.
function dropTarget(y, rows, rowEls, tasks, tbl, dragged, subtree) {
  const items = rows.map((r) => ({ r, el: rowEls.get(r.task.id) })).filter((x) => x.el);
  if (!items.length || !tbl) return null;
  let hit = -1;
  let rect = null;
  for (let i = 0; i < items.length; i++) {
    const r = items[i].el.getBoundingClientRect();
    if (y < r.bottom) {
      hit = i;
      rect = r;
      break;
    }
  }
  const lastDesc = (i) => {
    let j = i;
    while (j + 1 < items.length && items[j + 1].r.depth > items[i].r.depth) j++;
    return j;
  };
  let tgt;
  if (hit < 0) {
    // Below every row: last at the top level.
    tgt = { zone: 'end', rowId: null, parentId: null, beforeId: null, depth: 0, lineAt: items.length - 1, edge: 'bottom' };
  } else {
    const { r: row } = items[hit];
    if (subtree.has(row.task.id)) return null;
    const rel = (y - rect.top) / rect.height;
    const parentId = parentOf(tasks, row.task);
    if (rel < 0.25) tgt = { zone: 'before', rowId: row.task.id, parentId, beforeId: row.task.id, depth: row.depth, lineAt: hit, edge: 'top' };
    else if (rel > 0.75)
      tgt = { zone: 'after', rowId: row.task.id, parentId, beforeId: nextSiblingId(tasks, row.task, dragged.id), depth: row.depth, lineAt: lastDesc(hit), edge: 'bottom' };
    else tgt = { zone: 'into', rowId: row.task.id, parentId: row.task.id, beforeId: null, depth: row.depth + 1, lineAt: lastDesc(hit), edge: 'bottom' };
  }
  tgt.noop = samePlace(tasks, dragged, tgt.parentId, tgt.beforeId);
  // Drop line, in .tbl coordinates, indented to the level it lands on.
  const lineEl = items[tgt.lineAt].el;
  const lr = lineEl.getBoundingClientRect();
  const nr = (lineEl.querySelector('.tbl__name') || lineEl).getBoundingClientRect();
  const tr = tbl.getBoundingClientRect();
  const x = Math.round(nr.left - tr.left - tbl.clientLeft + tgt.depth * INDENT + 2);
  tgt.line = {
    x,
    y: Math.round((tgt.edge === 'top' ? lr.top : lr.bottom) - tr.top - tbl.clientTop),
    w: Math.max(40, Math.round(lr.right - tr.left - tbl.clientLeft - x - 8)),
  };
  tgt.key = `${tgt.zone}:${tgt.rowId}:${tgt.line.x}:${tgt.line.y}:${tgt.line.w}:${tgt.noop}`;
  return tgt;
}

export default function TableView({ board }) {
  const { t, run } = useBun();
  const now = useNow(60000).getTime();
  const [focusId, setFocusId] = useState(null);
  const [drag, setDrag] = useState(null); // { id, subtree, rect, source, target, dropping }
  const [landed, setLanded] = useState(null);
  const rows = numberTasks(board.tasks);
  const wrapRef = useRef(null);
  const tblRef = useRef(null);
  const ghostRef = useRef(null);
  const rowEls = useRef(new Map());
  const flip = useRef(null);
  const live = useRef({});
  // Row order + parents; changes when a move has come back from the backend.
  const sig = rows.map((r) => `${r.task.id}:${r.task.parentId || ''}`).join('|');
  live.current = { rows, tasks: board.tasks, sig };

  const addTask = async (opts = {}) => {
    const task = await run(api.createTask({ boardId: board.id, name: '', ...opts }));
    setFocusId(task.id);
  };

  // While a drop is waiting for the backend the ghost stays put; once the new
  // order arrives the rows glide from where they were to where they are (FLIP).
  const shown = drag && (!drag.dropping || drag.dropping === 'back' || drag.dropping === sig) ? drag : null;
  useLayoutEffect(() => {
    const f = flip.current;
    if (!f || f.sig === sig) return;
    flip.current = null;
    for (const [id, el] of rowEls.current) {
      const first = f.rects.get(id);
      if (!first) continue;
      const r = el.getBoundingClientRect();
      const dx = first.left - r.left;
      const dy = first.top - r.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 240, easing: EASE });
    }
    setLanded(f.id);
    setDrag(null);
  }, [sig]);

  useEffect(() => {
    if (!landed) return;
    const id = setTimeout(() => setLanded(null), 900);
    return () => clearTimeout(id);
  }, [landed]);

  useEffect(() => {
    document.body.classList.toggle('is-row-dragging', !!drag);
    return () => document.body.classList.remove('is-row-dragging');
  }, [!!drag]); // eslint-disable-line react-hooks/exhaustive-deps

  const onGripDown = (e, row) => {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const id = row.task.id;
    const el = rowEls.current.get(id);
    if (!el) return;
    e.preventDefault();
    const pid = e.pointerId;
    const start = { x: e.clientX, y: e.clientY };
    const subtree = subtreeIds(board.tasks, id);
    let last = start;
    let active = false;
    let raf = 0;

    const target = () => {
      const { rows: list, tasks } = live.current;
      const task = tasks.find((x) => x.id === id);
      return task ? dropTarget(last.y, list, rowEls.current, tasks, tblRef.current, task, subtree) : null;
    };

    const frame = () => {
      raf = 0;
      if (ghostRef.current) ghostRef.current.style.transform = `translate3d(${last.x - start.x}px, ${last.y - start.y}px, 0)`;
      // Scroll when the pointer nears the top or bottom edge.
      const wrap = wrapRef.current;
      let scrolled = false;
      if (wrap) {
        const wr = wrap.getBoundingClientRect();
        const top = Math.max(wr.top, 0) + EDGE;
        const bottom = Math.min(wr.bottom, window.innerHeight) - EDGE;
        const speed = last.y < top ? -(top - last.y) : last.y > bottom ? last.y - bottom : 0;
        if (speed) {
          const before = wrap.scrollTop;
          wrap.scrollTop += Math.max(-18, Math.min(18, Math.round((speed / EDGE) * 16)));
          scrolled = wrap.scrollTop !== before;
        }
      }
      const tgt = target();
      setDrag((d) => (d && !d.dropping && d.target?.key !== tgt?.key ? { ...d, target: tgt } : d));
      if (scrolled) raf = requestAnimationFrame(frame);
    };

    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
      cancelAnimationFrame(raf);
    };

    const goBack = () => {
      const g = ghostRef.current;
      if (g) {
        g.style.transition = `transform 200ms ${EASE}`;
        g.style.transform = 'translate3d(0, 0, 0)';
        g.classList.add('is-returning');
      }
      setDrag((d) => d && { ...d, target: null, dropping: 'back' });
      setTimeout(() => setDrag((d) => (d?.dropping === 'back' ? null : d)), 210);
    };

    const finish = (cancel) => {
      stop();
      if (!active) return;
      const tgt = cancel ? null : target();
      if (!tgt || tgt.noop) return goBack();
      // Remember where every row is; the moved rows start from the ghost.
      const rects = new Map();
      for (const [rid, rowEl] of rowEls.current) rects.set(rid, rowEl.getBoundingClientRect());
      const g = ghostRef.current?.firstChild?.getBoundingClientRect();
      const src = rects.get(id);
      if (g && src) {
        for (const sid of subtree) {
          const r = rects.get(sid);
          if (r) rects.set(sid, { left: r.left + g.left - src.left, top: r.top + g.top - src.top });
        }
      }
      const at = live.current.sig;
      flip.current = { sig: at, rects, id };
      setDrag((d) => d && { ...d, target: null, dropping: at });
      run(api.moveTask(id, { parentId: tgt.parentId, beforeId: tgt.beforeId })).catch(() => {
        flip.current = null;
        setDrag(null);
      });
      // Safety net: never leave a ghost behind.
      setTimeout(() => setDrag((d) => (d?.dropping === at ? null : d)), 2000);
    };

    const onMove = (ev) => {
      if (ev.pointerId !== pid) return;
      last = { x: ev.clientX, y: ev.clientY };
      if (!active) {
        if (Math.hypot(last.x - start.x, last.y - start.y) < 4) return;
        active = true;
        // Rows still gliding from the last drop would hit-test in the wrong place.
        for (const rowEl of rowEls.current.values()) rowEl.getAnimations().forEach((a) => a.finish());
        if (document.activeElement && el.contains(document.activeElement)) document.activeElement.blur();
        const r = el.getBoundingClientRect();
        setDrag({ id, subtree, source: el, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, target: null, dropping: null });
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

  const tgt = shown?.target && !shown.target.noop ? shown.target : null;

  return (
    <div className="tbl-wrap" ref={wrapRef}>
      <div className={`tbl card ${shown ? 'is-sorting' : ''}`} ref={tblRef}>
        <div className="tbl__row tbl__row--head">
          <span />
          <span className="tbl__num">{t('board.colNo')}</span>
          <span>{t('task.name')}</span>
          <span>{t('task.role')}</span>
          <span>{t('task.assignees')}</span>
          <span>{t('task.due')}</span>
          <span />
        </div>
        {rows.map(({ task, num, depth }) => (
          <TaskRow
            key={task.id}
            board={board}
            task={task}
            num={num}
            depth={depth}
            now={now}
            autoFocus={focusId === task.id}
            dragClass={
              shown?.subtree.has(task.id) ? 'is-drag-src' : tgt?.zone === 'into' && tgt.rowId === task.id ? 'is-drop-into' : landed === task.id ? 'is-landed' : ''
            }
            rowRef={(el) => (el ? rowEls.current.set(task.id, el) : rowEls.current.delete(task.id))}
            onGripDown={(e) => onGripDown(e, { task, num, depth })}
            onEnter={() => addTask({ parentId: task.parentId, afterId: task.id })}
            onAddSub={() => addTask({ parentId: task.id })}
          />
        ))}
        {rows.length === 0 && <div className="tbl__empty">{t('board.empty')}</div>}
        <button className="tbl__add" onClick={() => addTask()}>
          <Icon name="plus" size={16} /> {t('board.addTask')}
        </button>
        {tgt && <div className="tbl-drop-line" style={{ transform: `translate(${tgt.line.x}px, ${tgt.line.y}px)`, width: tgt.line.w }} />}
      </div>
      {shown && <RowGhost ghostRef={ghostRef} source={shown.source} rect={shown.rect} count={shown.subtree.size - 1} />}
    </div>
  );
}

// The lifted copy of the dragged row that follows the pointer.
function RowGhost({ ghostRef, source, rect, count }) {
  const holder = useRef(null);
  useLayoutEffect(() => {
    const clone = source.cloneNode(true);
    clone.classList.remove('is-drag-src', 'is-drop-into', 'is-landed');
    const inputs = source.querySelectorAll('input');
    clone.querySelectorAll('input').forEach((input, i) => (input.value = inputs[i]?.value ?? ''));
    clone.setAttribute('aria-hidden', 'true');
    holder.current.prepend(clone);
    return () => clone.remove();
  }, [source]);
  return createPortal(
    <div className="tbl-ghost" ref={ghostRef} style={{ left: rect.left, top: rect.top, width: rect.width }}>
      <div className="tbl-ghost__lift" ref={holder}>
        {count > 0 && <span className="tbl-ghost__count">+{count}</span>}
      </div>
    </div>,
    document.body,
  );
}

function TaskRow({ board, task, num, depth, now, autoFocus, dragClass, rowRef, onGripDown, onEnter, onAddSub }) {
  const { t, lang, run, user } = useBun();
  const [name, setName] = useState(task.name);
  const [pop, setPop] = useState(null); // { kind, anchor }
  const focused = useRef(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!focused.current) setName(task.name);
  }, [task.name]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const update = (patch) => run(api.updateTask(task.id, patch));
  const saveName = () => name !== task.name && update({ name });
  const mine = task.assignees.includes(user.id);
  const canDelete = board.canManage || task.createdBy === user.id;
  const open = (kind) => (e) => setPop({ kind, anchor: e.currentTarget.getBoundingClientRect() });
  const late = isOverdue(task, now);

  return (
    <div className={`tbl__row ${task.done ? 'is-done' : ''} ${dragClass}`} ref={rowRef}>
      <span className="tbl__check">
        <span className="tbl__grip" onPointerDown={onGripDown} title={t('board.dragHint')}>
          <Icon name="grip" size={16} stroke={3} />
        </span>
        <button className={`checkbox ${task.done ? 'is-on' : ''}`} onClick={() => update({ done: !task.done })} title={t('task.done')}>
          {task.done && <Icon name="check" size={13} stroke={3} />}
        </button>
      </span>
      <span className="tbl__num">{num}</span>
      <span className="tbl__name" style={{ paddingLeft: depth * INDENT }}>
        {depth > 0 && <span className="tbl__branch" />}
        <input
          ref={inputRef}
          value={name}
          placeholder={t('task.namePh')}
          maxLength={200}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            saveName();
          }}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              saveName();
              if (name.trim()) onEnter();
            }
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
      </span>
      <span className="tbl__cell">
        <button className="cell-btn" onClick={open('role')}>
          {task.role ? <span className="chip">{task.role}</span> : <span className="faint">—</span>}
        </button>
      </span>
      <span className="tbl__cell tbl__people">
        <button className={`claim ${mine ? 'is-on' : ''}`} onClick={() => run(api.toggleClaim(task.id))} title={t('task.claim')}>
          {mine && <Icon name="check" size={12} stroke={3.2} />}
        </button>
        <button className="cell-btn" onClick={open('people')}>
          {task.assigneeUsers.length ? <Assignees users={task.assigneeUsers} size={24} /> : <span className="faint">—</span>}
          {board.canManage && <Icon name="userPlus" size={14} className="cell-btn__hint" />}
        </button>
      </span>
      <span className="tbl__cell tbl__due">
        <button
          className={`cell-btn ${task.due ? 'cell-btn--time' : ''} ${late ? 'is-overdue' : ''}`}
          onClick={open('due')}
          title={late ? t('board.overdue') : t('task.due')}
        >
          {task.due ? (
            <>
              <Icon name="flag" size={13} /> {fmtDue(task.due, lang)}
            </>
          ) : (
            <span className="faint">—</span>
          )}
        </button>
      </span>
      <span className="tbl__actions">
        <button className="icon-btn icon-btn--sm" title={t('task.addSub')} onClick={onAddSub}>
          <Icon name="subtask" size={15} />
        </button>
        {canDelete && (
          <button className="icon-btn icon-btn--sm" title={t('task.delete')} onClick={() => run(api.deleteTask(task.id))}>
            <Icon name="trash" size={15} />
          </button>
        )}
      </span>

      {pop?.kind === 'role' && <RolePop task={task} anchor={pop.anchor} onClose={() => setPop(null)} onSave={(role) => update({ role })} />}
      {pop?.kind === 'due' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} className="cell-pop">
          <span className="label">{t('task.due')}</span>
          <DeadlineField value={task.due} onChange={(due) => update({ due })} />
        </Popover>
      )}
      {pop?.kind === 'people' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} className="cell-pop">
          <span className="label">{t('task.assignees')}</span>
          <AssigneeList board={board} value={task.assignees} onChange={(assignees) => update({ assignees })} />
        </Popover>
      )}
    </div>
  );
}

function RolePop({ task, anchor, onClose, onSave }) {
  const { t } = useBun();
  const [role, setRole] = useState(task.role || '');
  const close = () => {
    if (role !== (task.role || '')) onSave(role);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={close} className="cell-pop">
      <span className="label">{t('task.role')}</span>
      <RoleInput value={role} onChange={setRole} onEnter={close} autoFocus small />
    </Popover>
  );
}
