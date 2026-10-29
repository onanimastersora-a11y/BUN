// BUN local backend.
//
// One class holds every piece of shared state (accounts, friends, chat, boards,
// tasks, notes, settings) and is used in two places:
//   - the Electron main process, persisted to a JSON file in %APPDATA%/BUN
//   - a plain browser (vite preview), persisted to localStorage
// Several accounts can live on one machine, so friends, chat, board sharing and
// assignment all work offline between local accounts. A future online backend
// only has to implement the same public methods.

import { dayKey } from './time.js';

const DB_VERSION = 1;

export const DEFAULT_SETTINGS = {
  leadMinutes: 5,
  language: 'vi',
  theme: 'light',
  petScale: 3,
  autostart: true,
  petHidden: false,
  lastBoardId: null,
  lastRecapDay: null,
  // Daily info board on the home screen.
  weather: { name: 'Hà Nội', lat: 21.0285, lon: 105.8542 },
  watchlist: [
    { id: 'vnindex', kind: 'yahoo', symbol: '^VNINDEX.VN', label: 'VN-Index' },
    { id: 'sjc', kind: 'gold', symbol: 'SJC', label: 'Vàng SJC' },
    { id: 'usdvnd', kind: 'yahoo', symbol: 'VND=X', label: 'USD/VND' },
  ],
  // Reminder sound: a built-in tone, a SoundCloud link or an audio file the user picked.
  ringtone: { kind: 'builtin', id: 'musicbox', url: '', fileId: null, fileName: '', volume: 0.8 },
};

function emptyDb() {
  return {
    version: DB_VERSION,
    session: null,
    users: {},
    settings: {},
    friendships: [],
    friendRequests: [],
    messages: [],
    boards: {},
    tasks: {},
    notes: {},
    notified: {},
  };
}

function randomId(len = 12) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

async function hashCode(code, saltHex) {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: 120000, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

export class BunError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const fail = (code) => {
  throw new BunError(code);
};

export class Backend {
  /** @param {{load: () => any, save: (db: any) => void}} storage */
  constructor(storage) {
    this.storage = storage;
    this.listeners = new Set();
    const loaded = storage.load();
    this.db = loaded && loaded.version === DB_VERSION ? { ...emptyDb(), ...loaded } : emptyDb();
  }

  // ---------- plumbing ----------

  onChange(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  commit(...topics) {
    this.storage.save(this.db);
    for (const cb of this.listeners) cb({ topics });
  }

  me() {
    const id = this.db.session?.userId;
    const user = id && this.db.users[id];
    if (!user) fail('NOT_LOGGED_IN');
    return user;
  }

  publicUser(user) {
    if (!user) return null;
    return { id: user.id, name: user.name, tag: user.tag, animal: user.animal, handle: `${user.name}#${user.tag}` };
  }

  userById(id) {
    return this.publicUser(this.db.users[id]);
  }

  // ---------- account ----------

  async getSession() {
    const id = this.db.session?.userId;
    const user = id && this.db.users[id];
    if (!user) return null;
    return { user: this.publicUser(user), settings: this.settingsFor(user.id) };
  }

  async register({ animal, name, code }) {
    name = String(name || '').trim();
    code = String(code || '');
    if (animal !== 'cat' && animal !== 'dog') fail('BAD_ANIMAL');
    if (name.length < 1 || name.length > 24) fail('BAD_NAME');
    if (code.length < 4) fail('CODE_TOO_SHORT');
    const sameName = Object.values(this.db.users).filter((u) => u.name.toLowerCase() === name.toLowerCase());
    for (const u of sameName) if ((await hashCode(code, u.codeSalt)) === u.codeHash) fail('ACCOUNT_EXISTS');
    const used = new Set(sameName.map((u) => u.tag));
    let tag;
    do tag = String(1000 + Math.floor(Math.random() * 9000));
    while (used.has(tag));
    const salt = toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const user = {
      id: randomId(),
      name,
      tag,
      animal,
      codeSalt: salt,
      codeHash: await hashCode(code, salt),
      createdAt: new Date().toISOString(),
    };
    this.db.users[user.id] = user;
    this.db.settings[user.id] = { ...DEFAULT_SETTINGS };
    this.db.session = { userId: user.id };
    // Every new account starts with one checklist board.
    const board = this.makeBoard(user.id, 'Checklist');
    this.db.settings[user.id].lastBoardId = board.id;
    this.commit('session', 'boards', 'settings');
    return this.getSession();
  }

  async login({ name, code }) {
    name = String(name || '').trim().toLowerCase();
    // Accept either "Name" or the full "Name#1234" handle.
    const [base, tag] = name.split('#');
    const candidates = Object.values(this.db.users).filter(
      (u) => u.name.toLowerCase() === base && (!tag || u.tag === tag),
    );
    for (const u of candidates) {
      if ((await hashCode(String(code || ''), u.codeSalt)) === u.codeHash) {
        this.db.session = { userId: u.id };
        this.commit('session', 'settings', 'boards', 'friends', 'chat', 'tasks', 'notes');
        return this.getSession();
      }
    }
    fail('LOGIN_FAILED');
  }

  // Switch between cat and dog.
  async updateProfile({ animal }) {
    const me = this.me();
    if (animal !== 'cat' && animal !== 'dog') fail('BAD_ANIMAL');
    me.animal = animal;
    this.commit('session', 'profile', 'friends', 'boards', 'tasks');
    return this.getSession();
  }

  async logout() {
    this.db.session = null;
    this.commit('session');
    return null;
  }

  // ---------- settings ----------

  settingsFor(userId) {
    return { ...DEFAULT_SETTINGS, ...(this.db.settings[userId] || {}) };
  }

  async getSettings() {
    return this.settingsFor(this.me().id);
  }

  async updateSettings(patch) {
    const me = this.me();
    const allowed = Object.keys(DEFAULT_SETTINGS);
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
    if ('leadMinutes' in clean) clean.leadMinutes = Math.max(1, Math.min(240, Math.round(Number(clean.leadMinutes) || 5)));
    if ('watchlist' in clean) clean.watchlist = (Array.isArray(clean.watchlist) ? clean.watchlist : []).slice(0, 12);
    this.db.settings[me.id] = { ...this.settingsFor(me.id), ...clean };
    this.commit('settings');
    return this.settingsFor(me.id);
  }

  // ---------- friends ----------

  areFriends(a, b) {
    return this.db.friendships.some((f) => (f.a === a && f.b === b) || (f.a === b && f.b === a));
  }

  friendIdsOf(userId) {
    return this.db.friendships.flatMap((f) => (f.a === userId ? [f.b] : f.b === userId ? [f.a] : []));
  }

  async listFriends() {
    const me = this.me();
    return this.friendIdsOf(me.id)
      .map((id) => {
        const unread = this.db.messages.filter((m) => m.from === id && m.to === me.id && !m.read).length;
        const last = this.lastMessageBetween(me.id, id);
        return { ...this.userById(id), unread, lastMessage: last ? { text: last.text, at: last.at, mine: last.from === me.id } : null };
      })
      .filter((f) => f.id)
      .sort((x, y) => (y.lastMessage?.at || '').localeCompare(x.lastMessage?.at || '') || x.name.localeCompare(y.name));
  }

  async listFriendRequests() {
    const me = this.me();
    return {
      incoming: this.db.friendRequests.filter((r) => r.to === me.id).map((r) => ({ id: r.id, user: this.userById(r.from), at: r.createdAt })),
      outgoing: this.db.friendRequests.filter((r) => r.from === me.id).map((r) => ({ id: r.id, user: this.userById(r.to), at: r.createdAt })),
    };
  }

  async sendFriendRequest(handle) {
    const me = this.me();
    const [name, tag] = String(handle || '').trim().split('#');
    if (!name || !tag) fail('BAD_HANDLE');
    const target = Object.values(this.db.users).find((u) => u.name.toLowerCase() === name.toLowerCase() && u.tag === tag.trim());
    if (!target) fail('USER_NOT_FOUND');
    if (target.id === me.id) fail('SELF_FRIEND');
    if (this.areFriends(me.id, target.id)) fail('ALREADY_FRIENDS');
    // If they already asked us, sending back means accepting.
    const reverse = this.db.friendRequests.find((r) => r.from === target.id && r.to === me.id);
    if (reverse) return this.respondFriendRequest(reverse.id, true);
    if (this.db.friendRequests.some((r) => r.from === me.id && r.to === target.id)) fail('REQUEST_PENDING');
    this.db.friendRequests.push({ id: randomId(), from: me.id, to: target.id, createdAt: new Date().toISOString() });
    this.commit('friends');
    return { status: 'sent', user: this.publicUser(target) };
  }

  async respondFriendRequest(requestId, accept) {
    const me = this.me();
    const req = this.db.friendRequests.find((r) => r.id === requestId && (r.to === me.id || r.from === me.id));
    if (!req) fail('NOT_FOUND');
    this.db.friendRequests = this.db.friendRequests.filter((r) => r.id !== requestId);
    if (accept && req.to === me.id && !this.areFriends(req.from, req.to)) {
      this.db.friendships.push({ a: req.from, b: req.to, since: new Date().toISOString() });
    }
    this.commit('friends');
    return { status: accept ? 'accepted' : 'declined' };
  }

  async removeFriend(friendId) {
    const me = this.me();
    this.db.friendships = this.db.friendships.filter((f) => !((f.a === me.id && f.b === friendId) || (f.a === friendId && f.b === me.id)));
    this.commit('friends');
  }

  // ---------- chat ----------

  lastMessageBetween(a, b) {
    for (let i = this.db.messages.length - 1; i >= 0; i--) {
      const m = this.db.messages[i];
      if ((m.from === a && m.to === b) || (m.from === b && m.to === a)) return m;
    }
    return null;
  }

  async listMessages(friendId) {
    const me = this.me();
    return this.db.messages
      .filter((m) => (m.from === me.id && m.to === friendId) || (m.from === friendId && m.to === me.id))
      .map((m) => ({ ...m, mine: m.from === me.id }));
  }

  async sendMessage(friendId, text) {
    const me = this.me();
    text = String(text || '').trim();
    if (!text) fail('EMPTY');
    if (!this.areFriends(me.id, friendId)) fail('NOT_FRIENDS');
    const msg = { id: randomId(), from: me.id, to: friendId, text: text.slice(0, 4000), at: new Date().toISOString(), read: false };
    this.db.messages.push(msg);
    this.commit('chat', 'friends');
    return { ...msg, mine: true };
  }

  async markRead(friendId) {
    const me = this.me();
    let changed = false;
    for (const m of this.db.messages) {
      if (m.from === friendId && m.to === me.id && !m.read) {
        m.read = true;
        changed = true;
      }
    }
    if (changed) this.commit('friends');
  }

  // ---------- boards ----------

  makeBoard(ownerId, name) {
    const now = new Date().toISOString();
    const board = { id: randomId(), name: name || 'Checklist', ownerId, members: { [ownerId]: 'owner' }, createdAt: now, updatedAt: now };
    this.db.boards[board.id] = board;
    return board;
  }

  boardOrFail(boardId) {
    const board = this.db.boards[boardId];
    if (!board) fail('BOARD_NOT_FOUND');
    return board;
  }

  memberBoard(boardId, userId) {
    const board = this.boardOrFail(boardId);
    if (!board.members[userId]) fail('NOT_A_MEMBER');
    return board;
  }

  canManage(board, userId) {
    return board.members[userId] === 'owner';
  }

  boardSummary(board, userId) {
    const tasks = Object.values(this.db.tasks).filter((t) => t.boardId === board.id && t.name);
    return {
      id: board.id,
      name: board.name,
      ownerId: board.ownerId,
      myRole: board.members[userId],
      isCreator: board.ownerId === userId,
      taskCount: tasks.length,
      doneCount: tasks.filter((t) => t.done).length,
      updatedAt: board.updatedAt,
    };
  }

  async listBoards() {
    const me = this.me();
    return Object.values(this.db.boards)
      .filter((b) => b.members[me.id])
      .map((b) => this.boardSummary(b, me.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createBoard(name) {
    const me = this.me();
    const board = this.makeBoard(me.id, String(name || '').trim().slice(0, 60) || 'Checklist');
    this.db.settings[me.id] = { ...this.settingsFor(me.id), lastBoardId: board.id };
    this.commit('boards', 'settings');
    return this.boardSummary(board, me.id);
  }

  async getBoard(boardId) {
    const me = this.me();
    const board = this.memberBoard(boardId, me.id);
    const tasks = Object.values(this.db.tasks)
      .filter((t) => t.boardId === board.id)
      .sort((a, b) => a.order - b.order);
    const members = Object.entries(board.members).map(([id, role]) => ({ ...this.userById(id), role, isCreator: id === board.ownerId }));
    return {
      ...this.boardSummary(board, me.id),
      canManage: this.canManage(board, me.id),
      members,
      tasks: tasks.map((t) => this.taskOut(t)),
    };
  }

  async renameBoard(boardId, name) {
    const me = this.me();
    const board = this.memberBoard(boardId, me.id);
    if (!this.canManage(board, me.id)) fail('FORBIDDEN');
    board.name = String(name || '').trim().slice(0, 60) || board.name;
    board.updatedAt = new Date().toISOString();
    this.commit('boards', 'tasks');
  }

  async deleteBoard(boardId) {
    const me = this.me();
    const board = this.boardOrFail(boardId);
    if (board.ownerId !== me.id) fail('FORBIDDEN');
    for (const t of Object.values(this.db.tasks)) if (t.boardId === boardId) delete this.db.tasks[t.id];
    delete this.db.boards[boardId];
    this.commit('boards', 'tasks');
  }

  // Opening a share link: join as a regular member (no-op if already in).
  async joinBoard(boardId) {
    const me = this.me();
    const board = this.boardOrFail(boardId);
    if (!board.members[me.id]) {
      board.members[me.id] = 'member';
      board.updatedAt = new Date().toISOString();
      this.commit('boards');
    }
    return this.boardSummary(board, me.id);
  }

  async leaveBoard(boardId) {
    const me = this.me();
    const board = this.memberBoard(boardId, me.id);
    if (board.ownerId === me.id) fail('CREATOR_CANNOT_LEAVE');
    delete board.members[me.id];
    for (const t of Object.values(this.db.tasks)) if (t.boardId === boardId) t.assignees = t.assignees.filter((id) => id !== me.id);
    this.commit('boards', 'tasks');
  }

  // Owners can promote members to owner (share owner rights) or demote them.
  async setMemberRole(boardId, userId, role) {
    const me = this.me();
    const board = this.memberBoard(boardId, me.id);
    if (!this.canManage(board, me.id)) fail('FORBIDDEN');
    if (userId === board.ownerId) fail('FORBIDDEN');
    if (!board.members[userId]) fail('NOT_A_MEMBER');
    if (role === 'remove') {
      delete board.members[userId];
      for (const t of Object.values(this.db.tasks)) if (t.boardId === boardId) t.assignees = t.assignees.filter((id) => id !== userId);
    } else board.members[userId] = role === 'owner' ? 'owner' : 'member';
    this.commit('boards', 'tasks');
  }

  // ---------- tasks ----------
  // A task belongs to a board, or to nobody (boardId null) when it was created
  // straight on the personal calendar. parentId builds the mindmap tree.

  taskOut(t) {
    return {
      ...t,
      assigneeUsers: t.assignees.map((id) => this.userById(id)).filter(Boolean),
      boardName: t.boardId ? this.db.boards[t.boardId]?.name || '' : null,
    };
  }

  taskAccess(taskId, userId) {
    const task = this.db.tasks[taskId];
    if (!task) fail('TASK_NOT_FOUND');
    if (task.boardId === null) {
      if (task.createdBy !== userId) fail('FORBIDDEN');
      return { task, board: null, manage: true };
    }
    const board = this.memberBoard(task.boardId, userId);
    return { task, board, manage: this.canManage(board, userId) };
  }

  cleanTimes(start, end) {
    if (!start) return { start: null, end: null };
    const s = new Date(start);
    if (isNaN(s)) fail('BAD_TIME');
    let e = end ? new Date(end) : new Date(s.getTime() + 60 * 60 * 1000);
    if (isNaN(e) || e <= s) e = new Date(s.getTime() + 60 * 60 * 1000);
    return { start: s.toISOString(), end: e.toISOString() };
  }

  async createTask({ boardId = null, parentId = null, name = '', role = '', start = null, end = null, assignees = [], afterId = null }) {
    const me = this.me();
    let board = null;
    if (boardId) {
      board = this.memberBoard(boardId, me.id);
      if (parentId && this.db.tasks[parentId]?.boardId !== boardId) fail('BAD_PARENT');
    } else parentId = null;
    const siblings = Object.values(this.db.tasks).filter((t) => t.boardId === boardId && t.parentId === parentId && (boardId || t.createdBy === me.id));
    let order = siblings.reduce((m, t) => Math.max(m, t.order), 0) + 1;
    if (afterId && this.db.tasks[afterId]) {
      // Insert right after a sibling: shift the later ones down.
      const after = this.db.tasks[afterId].order;
      for (const t of siblings) if (t.order > after) t.order += 1;
      order = after + 1;
    }
    const now = new Date().toISOString();
    const task = {
      id: randomId(),
      boardId,
      parentId,
      order,
      name: String(name).trim().slice(0, 200),
      role: String(role).trim().slice(0, 40),
      ...this.cleanTimes(start, end),
      assignees: [],
      done: false,
      createdBy: me.id,
      createdAt: now,
      updatedAt: now,
    };
    this.db.tasks[task.id] = task;
    if (assignees.length) this.applyAssignees(task, board, me, assignees);
    if (board) board.updatedAt = now;
    this.commit('tasks', 'boards');
    return this.taskOut(task);
  }

  async updateTask(taskId, patch) {
    const me = this.me();
    const { task, board } = this.taskAccess(taskId, me.id);
    if ('name' in patch) task.name = String(patch.name).trim().slice(0, 200);
    if ('role' in patch) task.role = String(patch.role || '').trim().slice(0, 40);
    if ('done' in patch) task.done = !!patch.done;
    if ('start' in patch || 'end' in patch) {
      const t = this.cleanTimes('start' in patch ? patch.start : task.start, 'end' in patch ? patch.end : task.end);
      if (t.start !== task.start) delete this.db.notified[me.id]?.[task.id];
      Object.assign(task, t);
    }
    if ('assignees' in patch) this.applyAssignees(task, board, me, patch.assignees);
    task.updatedAt = new Date().toISOString();
    if (board) board.updatedAt = task.updatedAt;
    this.commit('tasks', 'boards');
    return this.taskOut(task);
  }

  // Owners may assign themselves, their friends and board members.
  // Everyone else may only add or remove themselves.
  applyAssignees(task, board, me, wanted) {
    wanted = [...new Set(wanted)];
    if (!board) {
      task.assignees = wanted.filter((id) => id === me.id);
      return;
    }
    const manage = this.canManage(board, me.id);
    const before = new Set(task.assignees);
    const changed = [...wanted.filter((id) => !before.has(id)), ...task.assignees.filter((id) => !wanted.includes(id))];
    if (!manage && changed.some((id) => id !== me.id)) fail('FORBIDDEN');
    for (const id of wanted) {
      if (before.has(id) || id === me.id) continue;
      if (!this.db.users[id]) fail('USER_NOT_FOUND');
      if (!board.members[id] && !this.areFriends(me.id, id)) fail('NOT_FRIENDS');
    }
    task.assignees = wanted.filter((id) => this.db.users[id]);
    // Someone assigned to a task can open the board it lives on.
    for (const id of task.assignees) if (!board.members[id]) board.members[id] = 'member';
  }

  async toggleClaim(taskId) {
    const me = this.me();
    const { task } = this.taskAccess(taskId, me.id);
    const next = task.assignees.includes(me.id) ? task.assignees.filter((id) => id !== me.id) : [...task.assignees, me.id];
    return this.updateTask(taskId, { assignees: next });
  }

  async deleteTask(taskId) {
    const me = this.me();
    const { task, board, manage } = this.taskAccess(taskId, me.id);
    if (board && !manage && task.createdBy !== me.id) fail('FORBIDDEN');
    const kill = (id) => {
      for (const t of Object.values(this.db.tasks)) if (t.parentId === id) kill(t.id);
      delete this.db.tasks[id];
    };
    kill(taskId);
    if (board) board.updatedAt = new Date().toISOString();
    this.commit('tasks', 'boards');
  }

  // Move a task to another position: before/after a sibling or into a new parent.
  async moveTask(taskId, { parentId = null, beforeId = null }) {
    const me = this.me();
    const { task, board } = this.taskAccess(taskId, me.id);
    if (!board) return this.taskOut(task);
    for (let p = parentId; p; p = this.db.tasks[p]?.parentId) if (p === taskId) fail('BAD_PARENT');
    const siblings = Object.values(this.db.tasks)
      .filter((t) => t.boardId === task.boardId && t.parentId === parentId && t.id !== taskId)
      .sort((a, b) => a.order - b.order);
    const idx = beforeId ? siblings.findIndex((t) => t.id === beforeId) : -1;
    siblings.splice(idx < 0 ? siblings.length : idx, 0, task);
    siblings.forEach((t, i) => (t.order = i + 1));
    task.parentId = parentId;
    board.updatedAt = new Date().toISOString();
    this.commit('tasks', 'boards');
    return this.taskOut(task);
  }

  // Everything that belongs on my calendar between two instants: my personal
  // events, plus timed board tasks I created or am assigned to.
  visibleOnCalendar(t, userId) {
    if (!t.start || !t.name) return false;
    if (t.boardId === null) return t.createdBy === userId;
    const board = this.db.boards[t.boardId];
    if (!board || !board.members[userId]) return false;
    return t.createdBy === userId || t.assignees.includes(userId);
  }

  async listCalendar(fromIso, toIso) {
    const me = this.me();
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    return Object.values(this.db.tasks)
      .filter((t) => this.visibleOnCalendar(t, me.id) && new Date(t.start).getTime() < to && new Date(t.end).getTime() > from)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((t) => this.taskOut(t));
  }

  async listRoles() {
    const me = this.me();
    const counts = new Map();
    for (const t of Object.values(this.db.tasks)) {
      if (!t.role) continue;
      const mine = t.boardId === null ? t.createdBy === me.id : !!this.db.boards[t.boardId]?.members[me.id];
      if (mine) counts.set(t.role, (counts.get(t.role) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  }

  // ---------- reminders (used by the pet) ----------

  // Calendar items starting within `leadMinutes` from now that have not been
  // announced yet. Each one is marked as announced so it fires once.
  async takeDueReminders(nowIso = new Date().toISOString()) {
    const me = this.me();
    const settings = this.settingsFor(me.id);
    const now = new Date(nowIso).getTime();
    const horizon = now + settings.leadMinutes * 60 * 1000;
    const seen = (this.db.notified[me.id] ||= {});
    const due = Object.values(this.db.tasks).filter((t) => {
      if (!this.visibleOnCalendar(t, me.id) || t.done) return false;
      const s = new Date(t.start).getTime();
      return s > now && s <= horizon && seen[t.id] !== t.start;
    });
    if (!due.length) return [];
    for (const t of due) seen[t.id] = t.start;
    // Forget reminders for things already over so the map stays small.
    for (const id of Object.keys(seen)) if (!this.db.tasks[id] || new Date(this.db.tasks[id].end).getTime() < now) delete seen[id];
    this.commit('reminders');
    return due.map((t) => ({ ...this.taskOut(t), minutes: Math.max(1, Math.round((new Date(t.start).getTime() - now) / 60000)) }));
  }

  // ---------- notes ----------

  async getNotes() {
    const me = this.me();
    const notes = this.db.notes[me.id] || {};
    return Object.entries(notes)
      .filter(([, n]) => n.text.trim())
      .map(([day, n]) => ({ day, text: n.text, updatedAt: n.updatedAt }))
      .sort((a, b) => b.day.localeCompare(a.day));
  }

  async getNote(day = dayKey()) {
    const me = this.me();
    return this.db.notes[me.id]?.[day]?.text || '';
  }

  async saveNote(text, day = dayKey()) {
    const me = this.me();
    const notes = (this.db.notes[me.id] ||= {});
    if (String(text).trim()) notes[day] = { text: String(text).slice(0, 20000), updatedAt: new Date().toISOString() };
    else delete notes[day];
    this.commit('notes');
  }

  // Once per day: what did I note on the most recent earlier day?
  async takeDailyRecap(today = dayKey()) {
    const me = this.me();
    const settings = this.settingsFor(me.id);
    if (settings.lastRecapDay === today) return null;
    this.db.settings[me.id] = { ...settings, lastRecapDay: today };
    this.commit('settings');
    const notes = this.db.notes[me.id] || {};
    const day = Object.keys(notes)
      .filter((d) => d < today && notes[d].text.trim())
      .sort()
      .pop();
    return day ? { day, text: notes[day].text } : null;
  }
}

// Every method the UI may call through IPC / the browser shim.
export const API_METHODS = [
  'getSession', 'register', 'login', 'logout', 'updateProfile',
  'getSettings', 'updateSettings',
  'listFriends', 'listFriendRequests', 'sendFriendRequest', 'respondFriendRequest', 'removeFriend',
  'listMessages', 'sendMessage', 'markRead',
  'listBoards', 'createBoard', 'getBoard', 'renameBoard', 'deleteBoard', 'joinBoard', 'leaveBoard', 'setMemberRole',
  'createTask', 'updateTask', 'toggleClaim', 'deleteTask', 'moveTask', 'listCalendar', 'listRoles',
  'takeDueReminders',
  'getNotes', 'getNote', 'saveNote', 'takeDailyRecap',
];
