import React, { useState } from 'react';
import { ACTION_SPECS } from '../game/actions';

interface Topic {
  title: string;
  body: string;
}

const UNITS: Topic[] = [
  {
    title: 'Infantry',
    body: 'The backbone of your force. Tough in defence, especially in towns, forests and on hills. Slower than armour but able to hold ground that armour cannot.',
  },
  {
    title: 'Armour',
    body: 'Tanks. The hardest hitters in open country and the fastest way to cover ground, but they lose much of their edge in forest and built-up areas.',
  },
  {
    title: 'Commandos',
    body: 'Light, fast, and able to raid far behind enemy lines with a Special Op. They hit hard and see far, but do not survive a stand-up fight.',
  },
  {
    title: 'Artillery',
    body: 'Guns that strike from many tiles away with a Fire Mission — but only at an enemy you have already spotted. Nearly helpless if the enemy reaches them.',
  },
  {
    title: 'Engineers',
    body: 'Build a bridge across a river so your land units can cross, or clear an enemy position of its dug-in defences. Poor fighters — keep them behind the line.',
  },
  {
    title: 'Recon',
    body: 'Recon units gather information about enemy forces. Use Recon to reveal hidden units and improve your understanding of the battlefield. They fight badly; their value is what they show you.',
  },
  {
    title: 'Air support',
    body: 'A strike called in from off-map onto any enemy you can see. It costs a sortie, and you only get a couple of sorties per turn, so save them for something that matters.',
  },
  {
    title: 'Naval units',
    body: 'Frigates and littoral squadrons move on navigable water only. They shell coastal targets from a distance and are the only formations that can hold an Anchorage.',
  },
];

const CONCEPTS: Topic[] = [
  {
    title: 'Terrain',
    body: 'The ground decides fights. Urban, forest and hill tiles make a defender much harder to shift; open ground and beaches leave them exposed. Roads halve the cost of moving; rivers stop land units until an engineer bridges them.',
  },
  {
    title: 'Combat',
    body: 'When you attack, both sides compute a strength from unit type, current strength, morale, readiness, supply, terrain, whether the defender is dug in, and whether friendly units are supporting nearby. The bigger number usually wins, with a small element of luck.',
  },
  {
    title: 'AP (Action Points)',
    body: 'Your whole side shares a pool of Action Points each turn. Every order spends some: moving costs 1, attacking 2, an air strike 3. When the pool runs low you must choose what matters most.',
  },
  {
    title: 'Movement actions',
    body: 'Separately from AP, each formation may only move a set number of times per round — usually two, three for fast units, one for artillery. The unit card shows "1 / 2 movement actions" so you know what is left.',
  },
  {
    title: 'Objectives',
    body: 'The marked locations — districts, bridges, ports, airfields, depots, anchorages. Occupy one to take control; every round you hold it, it pays Victory Points. First to 200 VP, or the higher score after 24 rounds, wins.',
  },
  {
    title: 'Fog of war',
    body: 'You only see what your units can see. A dashed circle with a "?" is an old contact: something was there, and the older it gets the less you should trust it. Recon turns guesses into facts.',
  },
];

export const HelpPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [tab, setTab] = useState<'units' | 'concepts' | 'keys'>('units');
  return (
    <div className="floating-panel help-panel" data-testid="help-panel">
      <div className="floating-head">
        <span>FIELD MANUAL</span>
        <button className="icon-btn" onClick={onClose} title="Close (?)">
          ✕
        </button>
      </div>
      <div className="help-tabs">
        <button className={tab === 'units' ? 'on' : ''} onClick={() => setTab('units')}>
          Units
        </button>
        <button className={tab === 'concepts' ? 'on' : ''} onClick={() => setTab('concepts')}>
          Concepts
        </button>
        <button className={tab === 'keys' ? 'on' : ''} onClick={() => setTab('keys')}>
          Shortcuts
        </button>
      </div>
      <div className="floating-body">
        {tab !== 'keys' &&
          (tab === 'units' ? UNITS : CONCEPTS).map((t) => (
            <div className="help-topic" key={t.title}>
              <b>{t.title}</b>
              <p>{t.body}</p>
            </div>
          ))}
        {tab === 'keys' && (
          <div className="key-grid">
            {ACTION_SPECS.map((a) => (
              <div key={a.id}>
                <kbd>{a.shortcut}</kbd> {a.label}
              </div>
            ))}
            <div>
              <kbd>E</kbd> End turn
            </div>
            <div>
              <kbd>Tab</kbd> Next formation with orders
            </div>
            <div>
              <kbd>Z</kbd> Centre on selected unit
            </div>
            <div>
              <kbd>Esc</kbd> Cancel targeting
            </div>
            <div>
              <kbd>L</kbd> Map legend
            </div>
            <div>
              <kbd>?</kbd> This manual
            </div>
            <div>
              <kbd>↑↓←→</kbd> Pan the map
            </div>
            <div>
              <kbd>+ / −</kbd> Zoom in / out
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
