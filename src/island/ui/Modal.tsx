// An accessible dialog: focus moves in and is trapped, Escape closes, and focus
// returns to whatever opened it.

import { ReactNode, useId, useRef } from 'react';
import { Icon, IconName } from './Glyphs';
import { useFocusTrap } from './useFocusTrap';
import './modal.css';

export function Modal({
  title, onClose, children, className = '', closable = true, labelHidden = false, kicker, icon,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
  closable?: boolean;
  labelHidden?: boolean;
  /** Small overline above the title, e.g. "Reference". */
  kicker?: string;
  /** Badge icon beside the title. */
  icon?: IconName;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, { onEscape: closable && onClose ? onClose : null });

  return (
    <div className="io-modal-backdrop io-mbd" onClick={closable ? onClose : undefined}>
      <div ref={ref} className={`io-card io-modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className={`io-modal-head${labelHidden ? ' io-sr' : ''}`}>
          {icon && (
            <span className="io-modal-icon" aria-hidden="true">
              <Icon name={icon} size={20} />
            </span>
          )}
          <span className="io-modal-titles">
            {kicker && <span className="io-modal-kicker">{kicker}</span>}
            <h2 id={id}>{title}</h2>
          </span>
          {closable && onClose && (
            <button className="io-icon-btn io-modal-close" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
