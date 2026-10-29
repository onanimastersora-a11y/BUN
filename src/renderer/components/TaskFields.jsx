import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useBun, useLive } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { PetAvatar } from '../sprite.jsx';
import { Popover } from './Popover.jsx';
import { atTime, dayKey, fmtRange, fmtTime, parseDayKey } from '../../core/time.js';

export function RoleInput({ value, onChange, onEnter, autoFocus, small }) {
  const { t } = useBun();
  const roles = useLive(() => api.listRoles(), [], ['tasks']) || [];
  const q = value.trim().toLowerCase();
  const suggestions = roles.filter((r) => r.toLowerCase() !== q && (!q || r.toLowerCase().includes(q))).slice(0, 6);
  return (
    <div>
      <input
        className={`input ${small ? 'input--sm' : ''}`}
        value={value}
        placeholder={t('task.rolePh')}
        autoFocus={autoFocus}
        maxLength={40}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
      />
      {suggestions.length > 0 && (
        <div className="role-suggest">
          {suggestions.map((r) => (
            <button key={r} type="button" className="chip chip--btn" onClick={() => onChange(r)}>
              {r}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function nextHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

export function TimeFields({ start, end, onChange }) {
  const { t } = useBun();
  if (!start) {
    return (
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => {
          const s = nextHour();
          onChange({ start: s.toISOString(), end: new Date(s.getTime() + 3600e3).toISOString() });
        }}
      >
        <Icon name="clock" size={15} /> {t('task.setTime')}
      </button>
    );
  }
  const s = new Date(start);
  const e = end ? new Date(end) : new Date(s.getTime() + 3600e3);
  const dur = e.getTime() - s.getTime();
  const setDate = (key) => {
    if (!key) return;
    const ns = atTime(parseDayKey(key), fmtTime(s));
    onChange({ start: ns.toISOString(), end: new Date(ns.getTime() + dur).toISOString() });
  };
  const setStart = (hhmm) => {
    if (!hhmm) return;
    const ns = atTime(s, hhmm);
    onChange({ start: ns.toISOString(), end: new Date(ns.getTime() + dur).toISOString() });
  };
  const setEnd = (hhmm) => {
    if (!hhmm) return;
    let ne = atTime(s, hhmm);
    if (ne <= s) ne = new Date(ne.getTime() + 24 * 3600e3);
    onChange({ start, end: ne.toISOString() });
  };
  return (
    <div className="time-fields">
      <input type="date" className="input input--sm" value={dayKey(s)} onChange={(ev) => setDate(ev.target.value)} />
      <div className="time-fields__row">
        <input type="time" className="input input--sm" value={fmtTime(s)} onChange={(ev) => setStart(ev.target.value)} />
        <span className="faint">→</span>
        <input type="time" className="input input--sm" value={fmtTime(e)} onChange={(ev) => setEnd(ev.target.value)} />
        <button type="button" className="icon-btn icon-btn--sm" title={t('task.clearTime')} onClick={() => onChange({ start: null, end: null })}>
          <Icon name="x" size={15} />
        </button>
      </div>
    </div>
  );
}

// Who is doing a board task. Everyone can claim it for themselves; owners can
// also tick friends and board members.
export function AssigneeList({ board, value, onChange }) {
  const { t, user } = useBun();
  const friends = useLive(() => api.listFriends(), [], ['friends']) || [];
  const mine = value.includes(user.id);
  const others = new Map();
  for (const m of board?.members || []) if (m.id !== user.id) others.set(m.id, m);
  for (const f of friends) others.set(f.id, f);
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="assignees">
      <label className="assignee-row assignee-row--me">
        <button type="button" className={`checkbox ${mine ? 'is-on' : ''}`} onClick={() => toggle(user.id)}>
          {mine && <Icon name="check" size={13} stroke={3} />}
        </button>
        <PetAvatar animal={user.animal} size={26} />
        <span className="assignee-row__name">{t('task.claim')}</span>
      </label>
      {board?.canManage ? (
        <>
          <div className="assignees__title">{t('task.assignFriends')}</div>
          {others.size === 0 && <div className="faint small">{t('task.noFriends')}</div>}
          <div className="assignees__list">
            {[...others.values()].map((u) => (
              <label key={u.id} className="assignee-row">
                <button type="button" className={`checkbox ${value.includes(u.id) ? 'is-on' : ''}`} onClick={() => toggle(u.id)}>
                  {value.includes(u.id) && <Icon name="check" size={13} stroke={3} />}
                </button>
                <PetAvatar animal={u.animal} size={26} />
                <span className="assignee-row__name">{u.name}</span>
                <span className="faint small">#{u.tag}</span>
              </label>
            ))}
          </div>
        </>
      ) : (
        <>
          {value.filter((id) => id !== user.id).length > 0 && (
            <div className="assignees__list">
              {value
                .filter((id) => id !== user.id)
                .map((id) => others.get(id))
                .filter(Boolean)
                .map((u) => (
                  <div key={u.id} className="assignee-row">
                    <PetAvatar animal={u.animal} size={26} />
                    <span className="assignee-row__name">{u.name}</span>
                  </div>
                ))}
            </div>
          )}
          <div className="faint small">{t('task.onlyOwner')}</div>
        </>
      )}
    </div>
  );
}

export function Assignees({ users, size = 22, max = 3 }) {
  if (!users?.length) return null;
  return (
    <span className="avatar-stack" title={users.map((u) => u.name).join(', ')}>
      {users.slice(0, max).map((u) => (
        <PetAvatar key={u.id} animal={u.animal} size={size} />
      ))}
      {users.length > max && <span className="avatar-more">+{users.length - max}</span>}
    </span>
  );
}

/**
 * The one task form used everywhere (calendar, table, roadmap, mindmap).
 * task: existing task, or null to create one from `draft` ({boardId, parentId, start, end}).
 * quick: calendar quick-add (name + role only, time shown read-only).
 */
export function TaskEditor({ anchor, task, draft, board: boardProp, quick = false, onClose, onSaved, placement }) {
  const { t, lang, run, user, navigate } = useBun();
  const base = task || { name: '', role: '', start: null, end: null, assignees: [], done: false, ...draft };
  const [name, setName] = useState(base.name);
  const [role, setRole] = useState(base.role || '');
  const [time, setTime] = useState({ start: base.start, end: base.end });
  const [assignees, setAssignees] = useState(base.assignees || []);
  const [done, setDone] = useState(!!base.done);
  const [board, setBoard] = useState(boardProp || null);
  const boardId = base.boardId || null;
  const saving = useRef(false);

  useEffect(() => {
    if (!boardProp && boardId) api.getBoard(boardId).then(setBoard).catch(() => {});
  }, [boardProp, boardId]);

  const canDelete = task && (!boardId || board?.canManage || task.createdBy === user.id);

  const save = async () => {
    if (saving.current) return;
    if (!name.trim()) return;
    saving.current = true;
    try {
      const fields = { name, role, start: time.start, end: time.end };
      if (boardId) Object.assign(fields, { assignees, done });
      const saved = task ? await run(api.updateTask(task.id, fields)) : await run(api.createTask({ boardId, parentId: base.parentId || null, ...fields }));
      onSaved?.(saved);
      onClose();
    } catch {
      saving.current = false;
    }
  };

  const remove = async () => {
    await run(api.deleteTask(task.id));
    onClose();
  };

  return (
    <Popover anchor={anchor} onClose={onClose} className="task-editor" placement={placement}>
      <div className="task-editor__head">
        {boardId && task && (
          <button type="button" className={`checkbox ${done ? 'is-on' : ''}`} onClick={() => setDone(!done)} title={t('task.done')}>
            {done && <Icon name="check" size={13} stroke={3} />}
          </button>
        )}
        <input
          className="task-editor__name"
          value={name}
          autoFocus
          maxLength={200}
          placeholder={t('task.namePh')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
      </div>

      {quick && time.start && (
        <div className="task-editor__when">
          <Icon name="clock" size={14} /> {fmtRange(time.start, time.end, lang)}
        </div>
      )}

      <div className="task-editor__field">
        <span className="label">{t('task.role')}</span>
        <RoleInput value={role} onChange={setRole} onEnter={save} small />
      </div>

      {!quick && (
        <div className="task-editor__field">
          <span className="label">{t('task.time')}</span>
          <TimeFields start={time.start} end={time.end} onChange={setTime} />
        </div>
      )}

      {!quick && boardId && board && (
        <div className="task-editor__field">
          <span className="label">{t('task.assignees')}</span>
          <AssigneeList board={board} value={assignees} onChange={setAssignees} />
        </div>
      )}

      {task?.boardName && !boardProp && (
        <button
          type="button"
          className="task-editor__board"
          onClick={() => {
            onClose();
            navigate({ view: 'board', boardId: task.boardId });
          }}
        >
          <Icon name="list" size={14} /> {task.boardName}
          <Icon name="chevronRight" size={14} />
        </button>
      )}

      <div className="task-editor__foot">
        {canDelete && (
          <button type="button" className="btn btn--sm btn--danger" onClick={remove}>
            <Icon name="trash" size={14} /> {t('task.delete')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
          {t('task.cancel')}
        </button>
        <button type="button" className="btn btn--sm btn--primary" disabled={!name.trim()} onClick={save}>
          {task ? t('task.save') : t('cal.add')}
        </button>
      </div>
    </Popover>
  );
}
