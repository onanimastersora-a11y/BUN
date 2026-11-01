import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useBun, useLive, useIsMobile } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { PetAvatar } from '../sprite.jsx';
import { Popover } from './Popover.jsx';
import { atTime, dayKey, fmtTime, parseDayKey } from '../../core/time.js';

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

const pad = (n) => String(n).padStart(2, '0');

// "930" -> "09:30", "1745" -> "17:45", "8" -> "08:00"; null when not a time.
function parseHHMM(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  let h;
  let m;
  if (digits.length <= 2) [h, m] = [Number(digits), 0];
  else if (digits.length === 3) [h, m] = [Number(digits.slice(0, 1)), Number(digits.slice(1))];
  else [h, m] = [Number(digits.slice(0, 2)), Number(digits.slice(2, 4))];
  if (h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

/**
 * Time box typed as digits: "1430" becomes 14:30 and, once four digits are in,
 * focus jumps to `nextRef` (the end time). Up/Down change it by 15 minutes.
 * Phones get the native time wheel instead.
 */
export function TimeInput({ value, onChange, nextRef, inputRef, label }) {
  const mobile = useIsMobile();
  const [text, setText] = useState(value);
  const own = useRef(null);
  const ref = inputRef || own;

  useEffect(() => setText(value), [value]);

  if (mobile) {
    return <input ref={ref} type="time" className="input input--sm time-input" value={value} aria-label={label} onChange={(e) => e.target.value && onChange(e.target.value)} />;
  }

  const commit = (raw) => {
    const v = parseHHMM(raw);
    if (v) onChange(v);
    else setText(value);
  };
  const step = (minutes) => {
    const [h, m] = value.split(':').map(Number);
    const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
    const q = Math.round(total / 15) * 15;
    onChange(`${pad(Math.floor(q / 60) % 24)}:${pad(q % 60)}`);
  };

  return (
    <input
      ref={ref}
      className="input input--sm time-input"
      inputMode="numeric"
      aria-label={label}
      value={text}
      maxLength={5}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        let v = e.target.value.replace(/[^\d:]/g, '');
        const digits = v.replace(/\D/g, '');
        // Auto colon after the hour; jump to the next box when complete.
        if (digits.length >= 3 && !v.includes(':')) v = `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
        setText(v);
        if (digits.length === 4 && parseHHMM(digits)) {
          onChange(parseHHMM(digits));
          nextRef?.current?.focus();
        }
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          step(15);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          step(-15);
        } else if (e.key === 'Enter') commit(e.currentTarget.value);
      }}
    />
  );
}

/** Date + start → end of a calendar event. Tab from the start goes straight to the end. */
export function TimeFields({ start, end, onChange, allowClear = true }) {
  const { t } = useBun();
  const endRef = useRef(null);
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
    const ns = atTime(s, hhmm);
    onChange({ start: ns.toISOString(), end: new Date(ns.getTime() + dur).toISOString() });
  };
  const setEnd = (hhmm) => {
    let ne = atTime(s, hhmm);
    if (ne <= s) ne = new Date(ne.getTime() + 24 * 3600e3);
    onChange({ start, end: ne.toISOString() });
  };
  return (
    <div className="time-fields">
      <input type="date" className="input input--sm" value={dayKey(s)} tabIndex={-1} onChange={(ev) => setDate(ev.target.value)} />
      <div className="time-fields__row">
        <TimeInput value={fmtTime(s)} onChange={setStart} nextRef={endRef} label={t('task.start')} />
        <span className="faint">→</span>
        <TimeInput value={fmtTime(e)} onChange={setEnd} inputRef={endRef} label={t('task.end')} />
        {allowClear && (
          <button type="button" className="icon-btn icon-btn--sm" tabIndex={-1} title={t('task.clearTime')} onClick={() => onChange({ start: null, end: null })}>
            <Icon name="x" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Deadline of a checklist item: one date + time (or none). */
export function DeadlineField({ value, onChange }) {
  const { t } = useBun();
  if (!value) {
    return (
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => {
          const d = new Date();
          d.setDate(d.getDate() + 1);
          d.setHours(17, 0, 0, 0);
          onChange(d.toISOString());
        }}
      >
        <Icon name="flag" size={15} /> {t('task.setDue')}
      </button>
    );
  }
  const d = new Date(value);
  return (
    <div className="time-fields__row deadline-field">
      <input type="date" className="input input--sm" value={dayKey(d)} onChange={(ev) => ev.target.value && onChange(atTime(parseDayKey(ev.target.value), fmtTime(d)).toISOString())} />
      <TimeInput value={fmtTime(d)} onChange={(hhmm) => onChange(atTime(d, hhmm).toISOString())} label={t('task.dueTime')} />
      <button type="button" className="icon-btn icon-btn--sm" title={t('task.clearDue')} onClick={() => onChange(null)}>
        <Icon name="x" size={15} />
      </button>
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
 * task: existing task or calendar item (may be one week of a repeating event),
 *       or null to create one from `draft` ({boardId, parentId, start, end}).
 * Calendar events: name, time, role, weekly repeat.
 * Checklist items: name, deadline, role, assignees, done.
 */
export function TaskEditor({ anchor, task, draft, board: boardProp, onClose, onSaved, placement }) {
  const { t, run, user, navigate } = useBun();
  const base = task || { name: '', role: '', start: null, end: null, due: null, repeat: null, assignees: [], done: false, ...draft };
  const boardId = base.boardId || null;
  const id = task ? task.seriesId || task.id : null;
  const [name, setName] = useState(base.name);
  const [role, setRole] = useState(base.role || '');
  const [time, setTime] = useState({ start: base.start, end: base.end });
  const [due, setDue] = useState(base.due ?? (boardId ? base.start : null) ?? null);
  const [repeat, setRepeat] = useState(!!base.repeat);
  const [assignees, setAssignees] = useState(base.assignees || []);
  const [done, setDone] = useState(!!base.done);
  const [board, setBoard] = useState(boardProp || null);
  const saving = useRef(false);

  useEffect(() => {
    if (!boardProp && boardId) api.getBoard(boardId).then(setBoard).catch(() => {});
  }, [boardProp, boardId]);

  const canDelete = task && (!boardId || board?.canManage || task.createdBy === user.id);

  const save = async () => {
    if (saving.current || !name.trim()) return;
    saving.current = true;
    try {
      let fields;
      if (boardId) fields = { name, role, due, assignees, done };
      else {
        fields = { name, role, repeat: repeat ? 'weekly' : null, start: time.start, end: time.end };
        // Editing one week of a repeating event moves the whole series by the same amount.
        if (task?.occurrence && time.start) {
          const delta = new Date(time.start) - new Date(task.start);
          const len = new Date(time.end) - new Date(time.start);
          const s = new Date(new Date(task.seriesStart).getTime() + delta);
          fields.start = s.toISOString();
          fields.end = new Date(s.getTime() + len).toISOString();
        }
      }
      const saved = task ? await run(api.updateTask(id, fields)) : await run(api.createTask({ boardId, parentId: base.parentId || null, ...fields }));
      onSaved?.(saved);
      onClose();
    } catch {
      saving.current = false;
    }
  };

  const remove = async (onlyThisWeek = false) => {
    if (onlyThisWeek) await run(api.skipOccurrence(id, task.occurrence));
    else await run(api.deleteTask(id));
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

      {/* Time first, right under the name. */}
      {boardId ? (
        <div className="task-editor__field">
          <span className="label">{t('task.due')}</span>
          <DeadlineField value={due} onChange={setDue} />
        </div>
      ) : (
        <div className="task-editor__field">
          <span className="label">{t('task.time')}</span>
          <TimeFields start={time.start} end={time.end} onChange={setTime} allowClear={false} />
          <label className="repeat-toggle">
            <button type="button" className={`switch switch--sm ${repeat ? 'is-on' : ''}`} onClick={() => setRepeat(!repeat)} />
            <span>{t('task.repeatWeekly')}</span>
          </label>
        </div>
      )}

      <div className="task-editor__field">
        <span className="label">{t('task.role')}</span>
        <RoleInput value={role} onChange={setRole} onEnter={save} small />
      </div>

      {boardId && board && (
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
        {canDelete && task?.occurrence && (
          <button type="button" className="btn btn--sm btn--danger" onClick={() => remove(true)}>
            <Icon name="trash" size={14} /> {t('task.deleteThisWeek')}
          </button>
        )}
        {canDelete && (
          <button type="button" className="btn btn--sm btn--danger" onClick={() => remove(false)}>
            <Icon name="trash" size={14} /> {task?.occurrence ? t('task.deleteSeries') : t('task.delete')}
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
