import React from 'react';
import { Overlays } from '../render/renderMap';

export const OverlayToggles: React.FC<{ overlays: Overlays; setOverlays: React.Dispatch<React.SetStateAction<Overlays>> }> = ({ overlays, setOverlays }) => {
  const toggle = (key: keyof Overlays) => setOverlays((o) => ({ ...o, [key]: !o[key] }));
  const item = (key: keyof Overlays, label: string) => (
    <button className={`overlay-toggle ${overlays[key] ? 'on' : ''}`} onClick={() => toggle(key)}>
      {label}
    </button>
  );
  return (
    <div className="overlay-bar">
      {item('terrain', 'Terrain')}
      {item('movement', 'Movement')}
      {item('intel', 'Intel')}
      {item('supply', 'Supply')}
      {item('objectives', 'Objectives')}
    </div>
  );
};
