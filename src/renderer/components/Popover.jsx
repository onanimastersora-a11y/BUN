import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Floating panel anchored to a point {x, y} or a rect {left, top, right, bottom}.
// Closes on Escape or a mousedown outside of it.
export function Popover({ anchor, onClose, children, className = '', style, placement = 'bottom' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const place = () => {
      const r = 'left' in anchor ? anchor : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
      const { width, height } = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 8;
      let left;
      let top;
      if (placement === 'right') {
        left = r.right + gap;
        if (left + width > vw - 12) left = r.left - width - gap;
        top = r.top;
      } else {
        left = r.left;
        top = r.bottom + gap;
        if (top + height > vh - 12) top = r.top - height - gap;
      }
      left = Math.max(12, Math.min(left, vw - width - 12));
      top = Math.max(12, Math.min(top, vh - height - 12));
      setPos({ left, top });
    };
    place();
    // Content can grow after async data arrives; stay inside the window.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor?.x, anchor?.y, anchor?.left, anchor?.top, placement]);

  useEffect(() => {
    const onDown = (e) => {
      // Clicks inside any popover (e.g. a nested menu) or on its toggle button keep us open.
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('.popover, [data-popover-keep]')) closeRef.current?.();
    };
    const onKey = (e) => e.key === 'Escape' && closeRef.current?.();
    // Defer so the click that opened us doesn't close us.
    const id = setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={{ ...pos, ...style }} onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

export function Modal({ onClose, children, className = '' }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className}`}>{children}</div>
    </div>,
    document.body,
  );
}
