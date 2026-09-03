import React, { useEffect, useState } from 'react';

/**
 * Compact, non-blocking "what changed since your last turn" line (phase 10
 * §2). Auto-fades on its own; the player can also dismiss it early with a
 * click. It intercepts no keyboard input and steals no focus — orientation,
 * not a gate on play.
 */
export const TurnSummaryBanner: React.FC<{ id: number; text: string; onDone: () => void }> = ({ id, text, onDone }) => {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    setFading(false);
    const fadeTimer = window.setTimeout(() => setFading(true), 6200);
    const doneTimer = window.setTimeout(onDone, 6800);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(doneTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div
      className={`turn-summary ${fading ? 'fading' : ''}`}
      data-testid="turn-summary"
      onClick={() => {
        setFading(true);
        window.setTimeout(onDone, 220);
      }}
      title="Click to dismiss"
    >
      <span className="turn-summary-tag">SITREP</span> {text}
    </div>
  );
};
