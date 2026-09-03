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
    body: 'The ground decides fights. Urban, forest and hill tiles make a defender much harder to shift; open ground and beaches leave them exposed. Rivers stop land units until an engineer bridges them. Every tile on the sheet has a grid reference — column letter, row number, e.g. H-42 — and that is the reference used in the movement preview, the order log and the battle report.',
  },
  {
    title: 'Combat',
    body: 'When you attack, both sides compute a strength from unit type, current strength, morale, readiness, supply, terrain, whether the defender is dug in, and whether friendly units are supporting nearby. The bigger number usually wins, with a small element of luck.',
  },
  {
    title: 'Morale',
    body: 'Morale is a long-term condition, not a running total. Every formation has a normal level it sits at and drifts back toward. Routine movement and small engagements do not shift it at all. What does: heavy casualties, a major attack repulsed, being driven off a position, losing an objective you held, losing a battalion nearby, being surrounded or isolated, or a serious supply failure. It recovers a few points each round when a formation is out of contact, in supply, holding its ground and near friendly forces — and taking an objective or resupplying lifts it. Elite has to be earned and cannot be farmed. The five bands — Elite, Steady, Stressed, Shaken, Broken — still multiply combat power, so a broken formation is a real liability.',
  },
  {
    title: 'AP (Action Points)',
    body: 'Your whole side shares a pool of Action Points each turn. Every order spends some: moving costs 1, attacking 2, an air strike 3. When the pool runs low you must choose what matters most.',
  },
  {
    title: 'Movement',
    body: 'Every formation publishes two numbers on its unit card: Movement — how many tiles one bound covers over ordinary ground — and Movement Actions — how many bounds it may make per round, e.g. "2 / 2", dropping to "1 / 2" once it has moved. Infantry cover 4 tiles a bound, armour and the fast units more, artillery and engineers 4 as well so the guns and the bridging plant can keep pace with the formations they support. Each bound also costs 1 AP. Arm Move with M and hover a tile: the preview names the grid reference, the distance, how hard the going is, the road bonus and how many movement actions the bound needs, before you commit.',
  },
  {
    title: 'Roads',
    body: 'Roads are a real operational advantage, not a rounding error. A road tile costs a flat, published price instead of its terrain cost: infantry manage 4 tiles cross-country but 6 along a road, and mechanised formations — armour, artillery, engineers, recce — roughly double their reach on a road. Armour and the heavy support units also pay a surcharge in forest and built-up ground, so tanks are fastest exactly where you would expect: roads and open country.',
  },
  {
    title: 'Move Formation',
    body: 'Shift-click two or more of your own formations (on the map or in the roster) to group them, then press Shift+M and click a destination. The whole group advances together, paced to its SLOWEST member, so an infantry-and-armour or armour-and-engineer pairing arrives as one. Each formation spends its own movement action and 1 AP — the total is shown before you confirm — and any formation that has no movement actions left is named rather than quietly dropped. It is entirely optional: ordinary single-unit movement is unchanged.',
  },
  {
    title: 'Formation cohesion',
    body: 'Artillery and engineers work for a manoeuvre formation. If a move would leave one more than six tiles from the formation it supports, the preview says so — "35 SCE is becoming separated from supported formation". It is advice, never a veto: proceed if you mean to.',
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
              <kbd>⇧M</kbd> Move Formation (grouped)
            </div>
            <div>
              <kbd>⇧click</kbd> Add / remove from group
            </div>
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
