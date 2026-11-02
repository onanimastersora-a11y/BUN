// Turns calendar items into push reminders. A phone whose account isn't on the
// cloud yet and the cloud itself build them the same way, so their ids match.

export const REMINDER_DAYS = 14;

export function remindersFor(items, { userName, leadMinutes, t, now = Date.now() }) {
  return items
    .filter((it) => !it.done)
    .map((it) => ({
      id: `${it.id}@${it.start}`,
      at: new Date(it.start).getTime() - leadMinutes * 60000,
      title: `${userName} 🐾`,
      body: t(it.kind === 'deadline' ? 'pet.deadlineAlert' : 'pet.taskAlert', { name: it.name, n: leadMinutes }),
      url: '/app/',
      tag: it.id,
    }))
    .filter((r) => r.at > now);
}
