// Helpers to turn a board's flat task list into a tree and numbered rows.

export function childrenMap(tasks) {
  const map = new Map();
  for (const t of tasks) {
    const key = t.parentId || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  for (const list of map.values()) list.sort((a, b) => a.order - b.order);
  return map;
}

// Depth-first rows with outline numbers: 1, 1.1, 1.2, 2 ...
export function numberTasks(tasks) {
  const kids = childrenMap(tasks);
  const ids = new Set(tasks.map((t) => t.id));
  const rows = [];
  const walk = (parentId, prefix, depth) => {
    (kids.get(parentId) || []).forEach((task, i) => {
      const num = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      rows.push({ task, num, depth });
      walk(task.id, num, depth + 1);
    });
  };
  walk(null, '', 0);
  // Orphans (parent deleted elsewhere) still show at the end.
  for (const t of tasks) if (t.parentId && !ids.has(t.parentId)) rows.push({ task: t, num: '·', depth: 0 });
  return rows;
}

// A task and everything under it (ids). Nothing may be dropped in here.
export function subtreeIds(tasks, id) {
  const kids = childrenMap(tasks);
  const out = new Set();
  const walk = (x) => {
    out.add(x);
    for (const c of kids.get(x) || []) walk(c.id);
  };
  walk(id);
  return out;
}

// Parent as the backend sees it: an orphan (parent gone) counts as top level.
export function parentOf(tasks, task) {
  return task.parentId && tasks.some((t) => t.id === task.parentId) ? task.parentId : null;
}

// Id of the sibling right after `task` (ignoring `skipId`), or null if it is last.
export function nextSiblingId(tasks, task, skipId = null) {
  const sibs = (childrenMap(tasks).get(parentOf(tasks, task)) || []).filter((t) => t.id !== skipId);
  const i = sibs.findIndex((t) => t.id === task.id);
  return i >= 0 && i + 1 < sibs.length ? sibs[i + 1].id : null;
}

// True when moveTask(task, { parentId, beforeId }) would leave it where it is.
export function samePlace(tasks, task, parentId, beforeId) {
  if (parentOf(tasks, task) !== parentId) return false;
  const all = childrenMap(tasks).get(parentId) || [];
  const others = all.filter((t) => t.id !== task.id);
  const now = all.findIndex((t) => t.id === task.id);
  const idx = beforeId ? others.findIndex((t) => t.id === beforeId) : -1;
  return (idx < 0 ? others.length : idx) === now;
}

// Past its deadline and not done yet.
export function isOverdue(task, now = Date.now()) {
  return !!task.due && !task.done && new Date(task.due).getTime() < now;
}

// Earliest deadline first; tasks without a deadline after them, in checklist order.
export function sortByDeadline(rows) {
  const timed = rows.filter((r) => r.task.due).sort((a, b) => new Date(a.task.due) - new Date(b.task.due));
  return [...timed, ...rows.filter((r) => !r.task.due)];
}

// Roadmap steps (named tasks, as numbered rows) in road order, first step first.
// No saved order: by deadline. Saved order: that order, then any task missing
// from it in deadline order; ids that no longer exist are ignored.
export function roadmapSteps(tasks, roadmapOrder = null) {
  const rows = sortByDeadline(numberTasks(tasks).filter((r) => r.task.name));
  if (!Array.isArray(roadmapOrder)) return rows;
  const pos = new Map(roadmapOrder.map((id, i) => [id, i]));
  const placed = rows.filter((r) => pos.has(r.task.id)).sort((a, b) => pos.get(a.task.id) - pos.get(b.task.id));
  return [...placed, ...rows.filter((r) => !pos.has(r.task.id))];
}
