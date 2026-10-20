// An accessible dialog: focus moves in and is trapped, Escape closes, and focus
// returns to whatever opened it.

import { ReactNode, useEffect, useId, useRef } from 'react';
import { Icon } from './Glyphs';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({
  title, onClose, children, className = '', closable = true, labelHidden = false,
}: { title: string; onClose?: () => void; children: ReactNode; className?: string; closable?: boolean; labelHidden?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closable && closeRef.current) {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const a = items[0], b = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) (e.preventDefault(), b.focus());
      else if (!e.shiftKey && document.activeElement === b) (e.preventDefault(), a.focus());
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
  }, [closable]);

  return (
    <div className="io-modal-backdrop" onClick={closable ? onClose : undefined}>
      <div ref={ref} className={`io-card io-modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className={`io-modal-head${labelHidden ? ' io-sr' : ''}`}>
          <h2 id={id}>{title}</h2>
          {closable && onClose && (
            <button className="io-icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
