import React from 'react';
import { TERRAIN_COLORS } from '../render/colors';

/**
 * Every legend entry pairs a colour swatch with a distinct symbol, so the map
 * stays readable without relying on colour perception alone.
 */
interface Entry {
  symbol: string;
  color: string;
  label: string;
  note: string;
}

const TERRAIN: Entry[] = [
  { symbol: '·', color: TERRAIN_COLORS.OPEN.base, label: 'Open ground', note: 'Fast to cross, no cover.' },
  { symbol: '“', color: TERRAIN_COLORS.GRASS.base, label: 'Grass / scrub', note: 'Easy going, very little cover.' },
  { symbol: '♣', color: TERRAIN_COLORS.FOREST.base, label: 'Forest', note: 'Slow, good cover, blocks sight.' },
  { symbol: '▲', color: TERRAIN_COLORS.HILLS.base, label: 'Hills / high ground', note: 'Slow to climb, strong defence.' },
  { symbol: '▣', color: TERRAIN_COLORS.URBAN.base, label: 'Urban district', note: 'Strongest defensive terrain.' },
  { symbol: '⌗', color: TERRAIN_COLORS.INDUSTRIAL.base, label: 'Industrial', note: 'Built-up, good cover.' },
  { symbol: '≈', color: TERRAIN_COLORS.WATER.base, label: 'Water', note: 'Ships only — land units need a bridge.' },
  { symbol: '⁘', color: TERRAIN_COLORS.BEACH.base, label: 'Beach', note: 'Coastal landing strip of sand — open, exposed.' },
  { symbol: '✈', color: TERRAIN_COLORS.AIRFIELD.base, label: 'Airfield', note: 'Supply source when you hold it.' },
  { symbol: '⚓', color: TERRAIN_COLORS.PORT.base, label: 'Port', note: 'Supply source, naval berth.' },
  { symbol: '═', color: '#e2d2b2', label: 'Road', note: 'Big movement bonus: infantry 4 tiles cross-country, 6 by road; mechanised formations roughly double.' },
  { symbol: '∿', color: '#29608a', label: 'River', note: 'Impassable to land units unless bridged.' },
  { symbol: '⌢', color: '#8a6b45', label: 'Bridge', note: 'Lets land units cross a water tile.' },
  { symbol: '⌒', color: '#6b4a1e', label: 'Contour line', note: 'Equal height. Thick lines every fifth contour.' },
];

const MARKERS: Entry[] = [
  { symbol: 'IN', color: '#6fa8c9', label: 'Friendly formation', note: 'Blue ring. Two letters give the arm.' },
  { symbol: 'IN', color: '#c17a5f', label: 'Enemy formation', note: 'Red ring — currently in sight.' },
  { symbol: '?', color: '#c1524a', label: 'Unknown contact', note: 'Dashed circle: last known position, fading confidence.' },
  { symbol: '★', color: '#cf9a44', label: 'Objective', note: 'Hold it to earn Victory Points each round.' },
  { symbol: '⚓', color: '#cf9a44', label: 'Anchorage', note: 'Maritime objective — only ships can hold it.' },
  { symbol: '◆', color: '#cf9a44', label: 'Supply depot', note: 'Projects supply around itself.' },
  { symbol: 'TY', color: '#93a35f', label: 'Artillery', note: 'Long-range fire missions, weak in close combat.' },
  { symbol: 'RC', color: '#93a35f', label: 'Recon', note: 'Reveals enemy forces over a wide radius.' },
  { symbol: '✈', color: '#e6b665', label: 'Air support', note: 'Called onto any spotted enemy; limited sorties.' },
  { symbol: '◎', color: '#e6b665', label: 'Selected unit', note: 'Amber ring, brackets and rotating dashes.' },
  { symbol: '▨', color: '#cf9a44', label: 'Movement range', note: 'Amber wash — tiles reachable with this move.' },
  { symbol: '◇', color: '#c1524a', label: 'Attack range', note: 'Dashed red diamond around the selected unit.' },
  { symbol: '⌂', color: '#93a35f', label: 'Fortified', note: 'Amber arc under a dug-in formation.' },
];

/** Pick a symbol colour that stays legible on its own swatch. */
function inkFor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
  return lum > 0.55 ? '#14181c' : '#f2f6f4';
}

function Row({ e }: { e: Entry }) {
  return (
    <div className="legend-row">
      <span className="legend-swatch" style={{ background: e.color }}>
        <span className="legend-symbol" style={{ color: inkFor(e.color), textShadow: 'none' }}>
          {e.symbol}
        </span>
      </span>
      <span className="legend-text">
        <b>{e.label}</b>
        <i>{e.note}</i>
      </span>
    </div>
  );
}

export const Legend: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div className="floating-panel legend-panel" data-testid="legend-panel">
    <div className="floating-head">
      <span>MAP LEGEND</span>
      <button className="icon-btn" onClick={onClose} title="Close (L)">
        ✕
      </button>
    </div>
    <div className="floating-body legend-cols">
      <div>
        <div className="legend-sub">TERRAIN</div>
        {TERRAIN.map((e) => (
          <Row key={e.label} e={e} />
        ))}
      </div>
      <div>
        <div className="legend-sub">MARKERS</div>
        {MARKERS.map((e) => (
          <Row key={e.label} e={e} />
        ))}
      </div>
    </div>
  </div>
);
