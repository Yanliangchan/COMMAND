import React from 'react';
import { Overlays } from '../render/renderMap';
import { SoundControl } from './SoundControl';

/** Compact overlay switches, floating over the sheet's top-right corner. */
export const OverlayToggles: React.FC<{
  overlays: Overlays;
  setOverlays: React.Dispatch<React.SetStateAction<Overlays>>;
  onLegend: () => void;
  onHelp: () => void;
  legendOpen: boolean;
  helpOpen: boolean;
}> = ({ overlays, setOverlays, onLegend, onHelp, legendOpen, helpOpen }) => {
  const toggle = (key: keyof Overlays) => setOverlays((o) => ({ ...o, [key]: !o[key] }));
  const item = (key: keyof Overlays, label: string, title: string) => (
    <button className={`chip-toggle ${overlays[key] ? 'on' : ''}`} onClick={() => toggle(key)} title={title}>
      {label}
    </button>
  );
  return (
    <div className="hud-tools">
      {item('movement', 'Move', 'Show the movement range of the selected formation')}
      {item('intel', 'Intel', 'Show suspected enemy contacts')}
      {item('objectives', 'Objectives', 'Show objective markers')}
      <span className="hud-sep" />
      <button className={`chip-toggle ${legendOpen ? 'on' : ''}`} onClick={onLegend} title="Map legend (L)" data-testid="legend-btn">
        L · Legend
      </button>
      <button className={`chip-toggle ${helpOpen ? 'on' : ''}`} onClick={onHelp} title="Field manual (?)" data-testid="help-btn">
        ? Help
      </button>
      <span className="hud-sep" />
      <SoundControl />
    </div>
  );
};
