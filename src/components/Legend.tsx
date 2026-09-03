import React from 'react';
import { PLAYER_COLORS, TERRAIN_COLORS } from '../render/colors';
import { FACTION_SHORT } from '../game/data';
import { PlayerId, otherPlayer } from '../game/types';

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
  { symbol: '✈', color: TERRAIN_COLORS.AIRFIELD.base, label: 'Airfield', note: 'Objective worth VP while you hold it.' },
  { symbol: '⚓', color: TERRAIN_COLORS.PORT.base, label: 'Port', note: 'Naval berth, and an objective worth VP.' },
  { symbol: '═', color: '#e2d2b2', label: 'Road', note: 'Big movement bonus: infantry 4 tiles cross-country, 6 by road; mechanised formations roughly double.' },
  { symbol: '∿', color: '#29608a', label: 'River', note: 'Impassable to land units unless bridged.' },
  { symbol: '⌢', color: '#8a6b45', label: 'Bridge', note: 'Lets land units cross a water tile.' },
  { symbol: '⌒', color: '#6b4a1e', label: 'Contour line', note: 'Equal height. Thick lines every fifth contour.' },
];

/**
 * The four detection states. Each is separated by SYMBOL as well as colour —
 * a hollow "?" blip, a dashed counter with a "?" badge, a solid counter with a
 * "✓" badge — so the ladder reads without relying on colour perception.
 */
const DETECTION_STATES: Entry[] = [
  {
    symbol: '·',
    color: '#3d4348',
    label: 'Unknown',
    note: 'Nothing detected. Not drawn at all — the server does not even tell your client the formation exists.',
  },
  {
    symbol: '?',
    color: '#b2703c',
    label: 'Contact',
    note: 'Hollow dashed blip. Something is at that grid; type, strength and identity are unknown. Shows the grid reference and confidence, e.g. "F-42 · 58%".',
  },
  {
    symbol: '?',
    color: '#cf7a4a',
    label: 'Identified',
    note: 'Dashed counter with the arm glyph and a "?" badge. You know it is, say, enemy infantry — not which battalion, nor its strength (the bar is hatched). You can attack it and you lose nothing for doing so, but the pre-attack preview can only give you a wide estimate.',
  },
  {
    symbol: '✓',
    color: '#c17a5f',
    label: 'Confirmed',
    note: 'Solid counter with a "✓" badge, full strength bar and the real designation. High confidence — the pre-attack preview against it is tight and reliable rather than a wide guess.',
  },
  {
    symbol: '↖',
    color: '#8a6244',
    label: 'Stale contact',
    note: 'A small tick on the blip means nobody is watching it now. Confidence decays each round and the contact slides back down the ladder.',
  },
  {
    symbol: '◉',
    color: '#e0a05c',
    label: 'Contact ping',
    note: 'Expanding rings on a tile just spotted. Click the banner at the top of the screen to jump there.',
  },
];

/**
 * Counter colours are per SIDE, not per allegiance, so the legend has to be
 * built against the viewer — a Task Force Vanguard player's own counters are
 * the red ones.
 */
const markersFor = (viewer: PlayerId): Entry[] => [
  {
    symbol: 'IN',
    color: PLAYER_COLORS[viewer].main,
    label: `Friendly formation (${FACTION_SHORT[viewer]})`,
    note: 'Your own counters. Two letters give the arm.',
  },
  {
    symbol: 'IN',
    color: PLAYER_COLORS[otherPlayer(viewer)].main,
    label: `Enemy formation (${FACTION_SHORT[otherPlayer(viewer)]})`,
    note: 'Currently detected. The badge says how well you know it.',
  },
  { symbol: '★', color: '#cf9a44', label: 'Objective', note: 'Pays Victory Points each round you are still holding it after the enemy has replied. The ones between the two deployment areas are worth two to three times a rear-area objective.' },
  { symbol: '⚓', color: '#cf9a44', label: 'Anchorage', note: 'Maritime objective — only ships can hold it.' },
  { symbol: '◆', color: '#cf9a44', label: 'Supply depot', note: 'An objective like any other — occupy it to score. It has no logistics effect.' },
  { symbol: 'TY', color: '#93a35f', label: 'Artillery', note: 'Long-range fire missions, weak in close combat.' },
  { symbol: 'RC', color: '#93a35f', label: 'Recon', note: 'Reveals enemy forces over a wide radius.' },
  { symbol: '✈', color: '#e6b665', label: 'Air support', note: 'Called onto any spotted enemy; limited sorties.' },
  { symbol: '◎', color: '#e6b665', label: 'Selected unit', note: 'Amber ring, brackets and rotating dashes.' },
  { symbol: '▨', color: '#cf9a44', label: 'Movement range', note: 'Amber wash — tiles reachable with this move.' },
  { symbol: '◇', color: '#c1524a', label: 'Attack range', note: 'Dashed red diamond around the selected unit.' },
  { symbol: '⌂', color: '#93a35f', label: 'Fortified', note: 'Amber arc under a dug-in formation.' },
  { symbol: '⚠', color: '#e6786a', label: 'On alert', note: 'Pulsing red-amber ring and a "!" badge. Did not act last round — will fire one reaction shot at an enemy that moves into its range and line of sight this opponent turn.' },
  { symbol: '▦', color: '#c1524a', label: 'Zone of Control', note: 'Red hatched tiles shown while a move order is armed. An enemy formation moving through one has its bound stopped there; leaving one you started in costs a full movement action.' },
  { symbol: '▬', color: '#8a6fae', label: 'Suppression', note: 'Purple bar under the strength bar. Cuts attack power and movement range up to 50% at maximum; decays each round it is not refreshed, faster in cover, slower in the open.' },
  { symbol: '✕', color: '#e6b665', label: 'Wreck marker', note: 'A brief cross-marker where a formation was just destroyed, held a few seconds on the map for both sides (redaction still applies).' },
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

export const Legend: React.FC<{ viewer: PlayerId; onClose: () => void }> = ({ viewer, onClose }) => (
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
        <div className="legend-sub">DETECTION STATES</div>
        {DETECTION_STATES.map((e) => (
          <Row key={e.label} e={e} />
        ))}
        <div className="legend-sub">MARKERS</div>
        {markersFor(viewer).map((e) => (
          <Row key={e.label} e={e} />
        ))}
      </div>
    </div>
  </div>
);
