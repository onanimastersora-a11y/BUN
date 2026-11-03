// First-run guide: walks a new account through each feature, one at a time. The
// feature in focus stays lit while the rest of the app is dimmed and its outline is
// drawn around it. Everything underneath is blocked until the guide ends.
//
// App.jsx starts it when TOUR_KEY is set (Onboarding sets it for a new account) and
// Settings can replay it. Targets are looked up by class name, so a step simply
// waits for its view to appear, and falls back to a centered card without one.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, bridge } from '../api.js';
import { useBun, useIsMobile } from '../store.jsx';
import { isIOS } from '../push.js';
import { PixelSprite } from '../sprite.jsx';

export const TOUR_KEY = 'bun-tour';

const BOARD_VIEW_KEY = 'bun-board-view';
const PAD = 6; // space between the feature and its outline
const EDGE = 4; // the outline never touches the window edge
const GAP = 14; // between the outline and the card
const MARGIN = 12; // between the card and the window edge
const RADIUS = 14;
const KEEP_MS = 400; // the outline waits this long for a view that is still opening

function tourSteps({ mobile, ios }) {
  // On the desktop the real pet is in its own window, out of reach: light its picture on Home.
  const petOnDesktop = bridge.isElectron;
  return [
    { id: 'welcome', view: 'home', sprite: true },
    { id: 'week', view: 'home', target: '.mini--schedule' },
    { id: 'schedule', view: 'calendar', target: '.cal__frame', text: mobile ? 'tour.schedule.phone' : null },
    { id: 'table', view: 'board', target: '.board__stage', tab: 'table' },
    { id: 'roadmap', view: 'board', target: '.board__stage', tab: 'roadmap' },
    { id: 'mindmap', view: 'board', target: '.board__stage', tab: 'mindmap' },
    { id: 'share', view: 'board', target: '.board__header' },
    { id: 'daily', view: 'home', target: '.daily' },
    { id: 'friends', view: mobile ? 'friends' : 'home', target: '.sidebar' },
    petOnDesktop ? { id: 'pet', view: 'home', target: '.hero__stage', text: 'tour.pet.desktop' } : { id: 'pet', view: 'home', target: '.pet-actor' },
    { id: 'settings', view: 'home', target: mobile ? '.mobile__top .icon-btn' : '.topbar__btn', text: ios ? 'tour.settings.ios' : null },
    { id: 'done', view: 'home' },
  ];
}

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// The feature's box, grown a little and kept inside the window.
function holeAround(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const left = clamp(r.left - PAD, EDGE, innerWidth - EDGE);
  const top = clamp(r.top - PAD, EDGE, innerHeight - EDGE);
  const right = clamp(r.right + PAD, EDGE, innerWidth - EDGE);
  const bottom = clamp(r.bottom + PAD, EDGE, innerHeight - EDGE);
  return { left, top, width: right - left, height: bottom - top };
}

const sameHole = (a, b) => a === b || (a && b && ['left', 'top', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) < 0.5));

// Beside the feature wherever it fits; over its bottom edge when it fills the window.
function placeCard(hole, card) {
  const x = (left) => clamp(left, MARGIN, innerWidth - card.w - MARGIN);
  const y = (top) => clamp(top, MARGIN, innerHeight - card.h - MARGIN);
  const right = hole.left + hole.width;
  const bottom = hole.top + hole.height;
  const centerX = hole.left + hole.width / 2 - card.w / 2;
  const centerY = hole.top + hole.height / 2 - card.h / 2;
  if (innerHeight - bottom - GAP - MARGIN >= card.h) return { left: x(centerX), top: bottom + GAP };
  if (hole.top - GAP - MARGIN >= card.h) return { left: x(centerX), top: hole.top - GAP - card.h };
  if (innerWidth - right - GAP - MARGIN >= card.w) return { left: right + GAP, top: y(centerY) };
  if (hole.left - GAP - MARGIN >= card.w) return { left: hole.left - GAP - card.w, top: y(centerY) };
  return { left: x(centerX), top: y(bottom - card.h - MARGIN) };
}

// A rounded box as one line, so it can be drawn from start to end.
function outlinePath(w, h) {
  const r = Math.min(RADIUS, w / 2, h / 2);
  return `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
}

export default function Tour({ onDone }) {
  const { user, t, route, navigate } = useBun();
  const mobile = useIsMobile();
  const steps = useMemo(() => tourSteps({ mobile, ios: isIOS() }), [mobile]);
  const [index, setIndex] = useState(0);
  const [hole, setHole] = useState(null);
  const [cardSize, setCardSize] = useState(null);
  const cardRef = useRef(null);
  const nextRef = useRef(null);
  const boardView = useRef(localStorage.getItem(BOARD_VIEW_KEY));
  const step = steps[index];
  const last = index === steps.length - 1;

  const finish = useCallback(() => {
    localStorage.removeItem(TOUR_KEY);
    // The guide flips through the board's views; leave the user's choice as it was.
    if (boardView.current) localStorage.setItem(BOARD_VIEW_KEY, boardView.current);
    else localStorage.removeItem(BOARD_VIEW_KEY);
    navigate({ view: 'home', enter: 'fade' });
    onDone();
  }, [navigate, onDone]);

  const go = useCallback((by) => setIndex((i) => clamp(i + by, 0, steps.length - 1)), [steps.length]);

  // Open the view this step lives in.
  useEffect(() => {
    if (route.view === step.view) return undefined;
    if (step.view !== 'board') {
      navigate({ view: step.view, enter: 'fade' });
      return undefined;
    }
    let stale = false;
    api.listBoards().then((boards) => {
      if (!stale && boards[0]) navigate({ view: 'board', boardId: boards[0].id, enter: 'fade' });
    });
    return () => {
      stale = true;
    };
  }, [step.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the feature every frame: views zoom in, the pet walks, the window resizes.
  useEffect(() => {
    const began = performance.now();
    let found = false;
    let frame;
    const tick = () => {
      const el = step.target && document.querySelector(step.target);
      if (el && !found) {
        found = true;
        if (step.tab) document.querySelector(`.board__tab[data-view="${step.tab}"]`)?.click();
        if (el.closest('.content')) el.scrollIntoView({ block: el.getBoundingClientRect().height > innerHeight * 0.8 ? 'start' : 'center', inline: 'nearest' });
      }
      const next = el ? holeAround(el) : null;
      setHole((prev) => {
        if (!next && step.target && prev && performance.now() - began < KEEP_MS) return prev;
        return sameHole(prev, next) ? prev : next;
      });
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [step]);

  useLayoutEffect(() => {
    const el = cardRef.current;
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    setCardSize((prev) => (prev && prev.w === size.w && prev.h === size.h ? prev : size));
  });

  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [index]);

  // Keys stay in the guide: the board also listens for the arrows.
  useEffect(() => {
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight' && !last) go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Tab') {
        const buttons = [...cardRef.current.querySelectorAll('button')];
        const at = buttons.indexOf(document.activeElement);
        e.preventDefault();
        buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [finish, go, last]);

  const tap = t(mobile ? 'tour.tap' : 'tour.click');
  const vars = { name: user.name, tap, tapl: tap.toLowerCase() };
  const cardStyle = hole && cardSize ? placeCard(hole, cardSize) : null;

  return createPortal(
    <div className="tour">
      {hole ? (
        <div className="tour__hole" style={hole}>
          <svg key={step.id} className="tour__ring" width={hole.width} height={hole.height}>
            <path d={outlinePath(hole.width, hole.height)} pathLength="100" />
          </svg>
        </div>
      ) : (
        <div className="tour__shade" />
      )}
      <div ref={cardRef} className={`tour__card ${cardStyle ? '' : 'is-center'}`} style={cardStyle || undefined} role="dialog" aria-modal="true" aria-labelledby="tour-title">
        {step.sprite && (
          <div key={step.id} className="tour__pet">
            <PixelSprite animal={user.animal} anim="sit" scale={2} />
            <svg className="tour__ring" width="100" height="100">
              <path d={outlinePath(100, 100)} pathLength="100" />
            </svg>
          </div>
        )}
        <div className="tour__count">
          {index + 1} / {steps.length}
        </div>
        <h3 id="tour-title" className="tour__title">
          {t(`tour.${step.id}.title`, vars)}
        </h3>
        <p className="tour__text">{t(step.text || `tour.${step.id}.text`, vars)}</p>
        <div className="tour__foot">
          {!last && (
            <button className="btn btn--sm btn--ghost" onClick={finish}>
              {t('tour.skip')}
            </button>
          )}
          <span className="tour__spacer" />
          {index > 0 && (
            <button className="btn btn--sm" onClick={() => go(-1)}>
              {t('tour.back')}
            </button>
          )}
          <button ref={nextRef} className="btn btn--sm btn--primary" onClick={() => (last ? finish() : go(1))}>
            {t(last ? 'tour.finish' : 'tour.next')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
