// Dialog focus handling shared by Modal and the end screen: focus moves in
// (to [data-autofocus], else the first control), Tab and Shift+Tab wrap inside,
// Escape either closes, is swallowed, or passes through, and focus can go back
// to whatever was focused before.

import { RefObject, useEffect, useRef } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export interface TrapOptions {
  /** Called on Escape; null = Escape does nothing here. */
  onEscape?: (() => void) | null;
  /** Swallow Escape so nothing behind the dialog reacts (an end screen that can't be dismissed). */
  blockEscape?: boolean;
  /** Return focus to the opener on unmount (default true). */
  restoreFocus?: boolean;
}

export function useFocusTrap(ref: RefObject<HTMLElement>, { onEscape = null, blockEscape = false, restoreFocus = true }: TrapOptions = {}) {
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  const hasEscape = !!onEscape;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (escRef.current) {
          e.stopPropagation();
          escRef.current();
        } else if (blockEscape) {
          e.stopPropagation();
          e.preventDefault();
        }
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const a = items[0], b = items[items.length - 1];
      const inside = el.contains(document.activeElement);
      if (!inside) (e.preventDefault(), (e.shiftKey ? b : a).focus());
      else if (e.shiftKey && (document.activeElement === a || document.activeElement === el)) (e.preventDefault(), b.focus());
      else if (!e.shiftKey && document.activeElement === b) (e.preventDefault(), a.focus());
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (restoreFocus) opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasEscape, blockEscape, restoreFocus]);
}

/** True when the viewer has asked for reduced motion. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
