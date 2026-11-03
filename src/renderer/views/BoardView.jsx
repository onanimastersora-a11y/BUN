import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useBun, useLive } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { PetAvatar } from '../sprite.jsx';
import { Popover } from '../components/Popover.jsx';
import { Assignees } from '../components/TaskFields.jsx';
import TableView from './board/TableView.jsx';
import RoadmapView from './board/RoadmapView.jsx';
import MindmapView from './board/MindmapView.jsx';

// Left arrow -> mindmap, right arrow -> roadmap; the checklist table sits in the middle.
const VIEWS = ['mindmap', 'table', 'roadmap'];
const VIEW_ICONS = { mindmap: 'mindmap', table: 'table', roadmap: 'roadmap' };

export const boardLink = (id) => `bun://board/${id}`;

export default function BoardView({ boardId }) {
  const { t, run, toast, navigate, user } = useBun();
  const board = useLive(() => api.getBoard(boardId), [boardId], ['tasks', 'boards', 'friends']);
  const boards = useLive(() => api.listBoards(), [], ['boards']) || [];
  const [index, setIndex] = useState(() => VIEWS.indexOf(localStorage.getItem('bun-board-view')) === -1 ? 1 : VIEWS.indexOf(localStorage.getItem('bun-board-view')));
  const [menu, setMenu] = useState(null);
  const [members, setMembers] = useState(null);
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (board) setTitle(board.name);
  }, [board?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem('bun-board-view', VIEWS[index]);
  }, [index]);

  useEffect(() => {
    api.updateSettings({ lastBoardId: boardId }).catch(() => {});
  }, [boardId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(VIEWS.length - 1, i + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (board === undefined) return <div className="board board--loading" />;
  if (board === null)
    return (
      <div className="board-missing">
        <p>{t('err.BOARD_NOT_FOUND')}</p>
        <button className="btn" onClick={() => navigate({ view: 'home' })}>
          {t('nav.home')}
        </button>
      </div>
    );

  const rename = () => {
    if (title.trim() && title !== board.name) run(api.renameBoard(board.id, title));
    else setTitle(board.name);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(boardLink(board.id));
    } catch {}
    toast(t('board.copied'));
  };

  const newBoard = async () => {
    setMenu(null);
    const b = await run(api.createBoard(t('board.newBoardName')));
    navigate({ view: 'board', boardId: b.id, enter: 'fade' });
  };

  const removeBoard = async () => {
    setMenu(null);
    if (!confirm(t('board.deleteConfirm', { name: board.name }))) return;
    await run(api.deleteBoard(board.id));
    navigate({ view: 'home', enter: 'back' });
  };

  const leave = async () => {
    setMenu(null);
    await run(api.leaveBoard(board.id));
    navigate({ view: 'home', enter: 'back' });
  };

  const view = VIEWS[index];

  return (
    <div className="board">
      <div className="board__header">
        <button className="board__switch" onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())} data-popover-keep>
          <Icon name="list" size={17} />
          <Icon name="chevronDown" size={14} />
        </button>
        <input
          className="board__title"
          value={title}
          readOnly={!board.canManage}
          maxLength={60}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="board__spacer" />
        <button className="share-link" onClick={copyLink} title={t('board.copy')}>
          <Icon name="link" size={15} />
          <span className="share-link__url">{boardLink(board.id)}</span>
          <span className="share-link__copy">
            <Icon name="copy" size={14} />
          </span>
        </button>
        <button className="board__members" onClick={(e) => setMembers(e.currentTarget.getBoundingClientRect())} data-popover-keep title={t('board.members')}>
          <Assignees users={board.members} size={26} max={4} />
          <Icon name="users" size={16} />
        </button>
      </div>

      <div className="board__tabs">
        {VIEWS.map((v, i) => (
          <button key={v} className={`board__tab ${i === index ? 'is-on' : ''}`} data-view={v} onClick={() => setIndex(i)}>
            <Icon name={VIEW_ICONS[v]} size={15} />
            {t(`board.views.${v}`)}
          </button>
        ))}
      </div>

      <div className="board__stage">
        {index > 0 && (
          <button className="edge-arrow edge-arrow--left" onClick={() => setIndex(index - 1)} title={t(`board.views.${VIEWS[index - 1]}`)}>
            <Icon name="chevronLeft" size={22} stroke={2.4} />
            <span>{t(`board.views.${VIEWS[index - 1]}`)}</span>
          </button>
        )}
        {index < VIEWS.length - 1 && (
          <button className="edge-arrow edge-arrow--right" onClick={() => setIndex(index + 1)} title={t(`board.views.${VIEWS[index + 1]}`)}>
            <span>{t(`board.views.${VIEWS[index + 1]}`)}</span>
            <Icon name="chevronRight" size={22} stroke={2.4} />
          </button>
        )}
        <div className="board__track" style={{ transform: `translateX(${-index * 100}%)` }}>
          {VIEWS.map((v, i) => (
            <section key={v} className={`board__panel board__panel--${v}`} {...(i === index ? {} : { inert: '' })} aria-hidden={i !== index}>
              {v === 'table' && <TableView board={board} />}
              {v === 'roadmap' && <RoadmapView board={board} active={view === 'roadmap'} />}
              {v === 'mindmap' && <MindmapView board={board} active={view === 'mindmap'} />}
            </section>
          ))}
        </div>
      </div>

      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)}>
          <div className="menu">
            <div className="menu-label">{t('board.myBoards')}</div>
            {boards.map((b) => (
              <button
                key={b.id}
                className={`menu-item ${b.id === board.id ? 'is-on' : ''}`}
                onClick={() => {
                  setMenu(null);
                  navigate({ view: 'board', boardId: b.id, enter: 'fade' });
                }}
              >
                <Icon name="list" size={15} />
                <span className="menu-item__text">{b.name}</span>
                <span className="faint small">
                  {b.doneCount}/{b.taskCount}
                </span>
              </button>
            ))}
            <div className="menu-sep" />
            <button className="menu-item" onClick={newBoard}>
              <Icon name="plus" size={15} /> {t('board.newBoard')}
            </button>
            {board.isCreator ? (
              <button className="menu-item menu-item--danger" onClick={removeBoard}>
                <Icon name="trash" size={15} /> {t('board.delete')}
              </button>
            ) : (
              <button className="menu-item menu-item--danger" onClick={leave}>
                <Icon name="logout" size={15} /> {t('board.leave')}
              </button>
            )}
          </div>
        </Popover>
      )}

      {members && (
        <Popover anchor={members} onClose={() => setMembers(null)} className="members-pop">
          <div className="members-pop__title">{t('board.members')}</div>
          <p className="faint small members-pop__hint">{t('board.shareHint')}</p>
          {board.members.map((m) => (
            <div key={m.id} className="member-row">
              <PetAvatar animal={m.animal} size={30} />
              <div className="member-row__who">
                <b>
                  {m.name}
                  {m.id === user.id && ' ✦'}
                </b>
                <span className="faint small">#{m.tag}</span>
              </div>
              <span className={`chip ${m.role === 'owner' ? 'chip--blue' : ''}`}>{m.isCreator ? t('board.creator') : m.role === 'owner' ? t('board.owner') : t('board.member')}</span>
              {board.canManage && !m.isCreator && m.id !== user.id && (
                <MemberMenu board={board} member={m} />
              )}
            </div>
          ))}
        </Popover>
      )}
    </div>
  );
}

function MemberMenu({ board, member }) {
  const { t, run } = useBun();
  const [open, setOpen] = useState(null);
  const act = async (role) => {
    setOpen(null);
    await run(api.setMemberRole(board.id, member.id, role));
  };
  return (
    <>
      <button className="icon-btn icon-btn--sm" onClick={(e) => setOpen(e.currentTarget.getBoundingClientRect())} data-popover-keep>
        <Icon name="more" size={16} />
      </button>
      {open && (
        <Popover anchor={open} onClose={() => setOpen(null)}>
          <div className="menu">
            {member.role === 'owner' ? (
              <button className="menu-item" onClick={() => act('member')}>
                {t('board.removeOwner')}
              </button>
            ) : (
              <button className="menu-item" onClick={() => act('owner')}>
                {t('board.makeOwner')}
              </button>
            )}
            <button className="menu-item menu-item--danger" onClick={() => act('remove')}>
              {t('board.removeMember')}
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}
