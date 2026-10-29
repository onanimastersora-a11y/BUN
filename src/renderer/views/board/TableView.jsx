import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useBun } from '../../store.jsx';
import { Icon } from '../../icons.jsx';
import { Popover } from '../../components/Popover.jsx';
import { AssigneeList, Assignees, RoleInput, TimeFields } from '../../components/TaskFields.jsx';
import { fmtRange } from '../../../core/time.js';
import { numberTasks } from './tree.js';

export default function TableView({ board }) {
  const { t, run } = useBun();
  const [focusId, setFocusId] = useState(null);
  const rows = numberTasks(board.tasks);

  const addTask = async (opts = {}) => {
    const task = await run(api.createTask({ boardId: board.id, name: '', ...opts }));
    setFocusId(task.id);
  };

  return (
    <div className="tbl-wrap">
      <div className="tbl card">
        <div className="tbl__row tbl__row--head">
          <span />
          <span className="tbl__num">{t('board.colNo')}</span>
          <span>{t('task.name')}</span>
          <span>{t('task.role')}</span>
          <span>{t('task.assignees')}</span>
          <span>{t('task.time')}</span>
          <span />
        </div>
        {rows.map(({ task, num, depth }) => (
          <TaskRow
            key={task.id}
            board={board}
            task={task}
            num={num}
            depth={depth}
            autoFocus={focusId === task.id}
            onEnter={() => addTask({ parentId: task.parentId, afterId: task.id })}
            onAddSub={() => addTask({ parentId: task.id })}
          />
        ))}
        {rows.length === 0 && <div className="tbl__empty">{t('board.empty')}</div>}
        <button className="tbl__add" onClick={() => addTask()}>
          <Icon name="plus" size={16} /> {t('board.addTask')}
        </button>
      </div>
    </div>
  );
}

function TaskRow({ board, task, num, depth, autoFocus, onEnter, onAddSub }) {
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

  return (
    <div className={`tbl__row ${task.done ? 'is-done' : ''}`}>
      <span className="tbl__check">
        <button className={`checkbox ${task.done ? 'is-on' : ''}`} onClick={() => update({ done: !task.done })} title={t('task.done')}>
          {task.done && <Icon name="check" size={13} stroke={3} />}
        </button>
      </span>
      <span className="tbl__num">{num}</span>
      <span className="tbl__name" style={{ paddingLeft: depth * 22 }}>
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
      <span className="tbl__cell">
        <button className={`cell-btn ${task.start ? 'cell-btn--time' : ''}`} onClick={open('time')}>
          {task.start ? (
            <>
              <Icon name="clock" size={13} /> {fmtRange(task.start, task.end, lang)}
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
      {pop?.kind === 'time' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} className="cell-pop">
          <span className="label">{t('task.time')}</span>
          <TimeFields start={task.start} end={task.end} onChange={(v) => update(v)} />
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
