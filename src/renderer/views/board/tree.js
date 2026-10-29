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
