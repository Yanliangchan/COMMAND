import React, { useEffect, useState } from 'react';
import { sound } from '../audio/sound';

/**
 * Small, unobtrusive master mute/volume control (phase 10 §5). Lives in the
 * HUD tool cluster next to the overlay toggles. Persisted client-side via
 * sound.ts (localStorage) so a viewer's choice survives a reload; it is a
 * per-viewer convenience, not game state, so it is never sent to the server.
 */
export const SoundControl: React.FC = () => {
  const [settings, setSettings] = useState(sound.getSettings());
  const [open, setOpen] = useState(false);

  useEffect(() => sound.subscribe(setSettings), []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest('.sound-control')) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const toggleMute = () => {
    const next = !settings.muted;
    sound.setMuted(next);
    if (!next) sound.play('ui');
  };

  return (
    <div className="sound-control">
      <button
        className={`chip-toggle ${!settings.muted ? 'on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Sound settings"
        data-testid="sound-btn"
      >
        {settings.muted ? '\u{1F507}' : '\u{1F50A}'} Sound
      </button>
      {open && (
        <div className="sound-popover" data-testid="sound-popover">
          <label className="sound-mute-row">
            <input type="checkbox" checked={!settings.muted} onChange={toggleMute} data-testid="sound-mute-checkbox" />
            Sound on
          </label>
          <label className="sound-vol-row">
            <span>Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.volume}
              disabled={settings.muted}
              onChange={(e) => sound.setVolume(parseFloat(e.target.value))}
              onMouseUp={() => sound.play('ui')}
              data-testid="sound-volume-slider"
            />
          </label>
        </div>
      )}
    </div>
  );
};
