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
    body: "Task Force Sabre's elite manoeuvre battalion. Light, fast, and able to raid far behind enemy lines with a Special Op. They hit hard, and only the C4I battalion sees further, but they do not survive a stand-up fight.",
  },
  {
    title: 'Guards',
    body: "Task Force Vanguard's elite manoeuvre battalion, and the commandos' counterpart. Air-assault infantry: just as mobile, and they can go in by helicopter with a Special Op, but at shorter reach and with ordinary sensors. In exchange they are markedly tougher once they are on the ground and fight as formed infantry.",
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
    body: 'The 24th C4I Battalion (and, on the other side, the 9th Recce & EW Battalion) is your sensor. It spots passively out to about 9 tiles where a rifle battalion manages 5 and a gun battalion 3, it identifies what it sees far faster, and it holds on to a contact for many rounds after everyone else has lost it. Its Recon order sweeps 14 tiles. It fights badly; its value is what it shows you.',
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
    title: 'The exercise',
    body: 'COMMAND is a fictional large-scale SAF force-on-force exercise. Two task forces drawn from the same armed forces fight each other over a fictional training area: TASK FORCE SABRE (1 SIR, 2 SIR, 5 SIR, 1 CDO BN, 40 SAR, 21 SA, 35 SCE, 10 C4I Bn, 185 SQN, 188 SQN) and TASK FORCE VANGUARD (3 SIR, 8 SIR, 9 SIR, 1 GDS, 41 SAR, 20 SA, 30 SCE, 11 C4I Bn, 191 SQN, 189 SQN). Both fight with the same weight of force: three rifle battalions, one elite manoeuvre battalion, armour, guns, engineers, a C4I battalion and two RSN squadrons each. The formation names and their real-world character are drawn from public sources; which battalion is on which side, and every number in the game, are fictional.',
  },
  {
    title: 'Initiative',
    body: 'One task force moves first each round — which one is rolled at the start of the operation and shown in the log. Moving first is worth something: you reach the contested ground first and make the other side attack into it. Scoring is deliberately blind to it, though: each side is paid for the objectives it still holds once the OTHER side has finished replying, so neither ever gets the last word on its own score.',
  },
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
    body: 'The marked locations — districts, bridges, ports, airfields, depots, anchorages. Occupy one to take control. An objective is only paid for once your opponent has had their reply and you are STILL holding it, so ground you take and immediately lose scores nothing: objectives have to be held, not merely touched. Objectives are not all worth the same. The ones on the axis between the two deployment areas — the towns, the trunk river crossings, the commanding hills — are worth two to three times a rear-area objective, so a force that stays home cannot reach the threshold in the time available. First to 280 VP, or the higher score after 24 rounds, wins.',
  },
  {
    title: 'Spotting — you do NOT need to Recon to see',
    body: 'Every formation watches its surroundings all the time, for free. If it has line of sight and an enemy comes inside its detection range, you see that enemy — on your turn or in the middle of the opponent\u2019s. Detection range depends on the formation (recon 9 tiles, commandos 7, warships 7-8, infantry and armour 5, engineers 4, artillery 3), on the ground you are standing on, on the ground the enemy is hiding in, and on height. A banner at the top of the screen tells you when something new is spotted and the map pings the tile — click either to jump there.',
  },
  {
    title: 'Line of sight and elevation',
    body: 'Sight is a ray across the map, not a circle. The game walks the height profile between the two tiles: ground higher than the sightline blocks it outright, and forest, housing and industrial fabric both raise that skyline and pile up haze that shortens your effective range. So elevation matters twice over — a battalion on a ridge sees roughly a third further AND sees over the low ground in between, while the same battalion in a valley wood is nearly blind. Open ground and hilltops are good places to watch from (×1.15 and ×1.35); forest and urban districts are bad ones (×0.55 and ×0.50). The same terrain conceals: an enemy sitting in a town is found at about half the distance it would be in the open, and digging in helps it hide too.',
  },
  {
    title: 'Detection states',
    body: 'What you know about an enemy is a four-rung ladder. UNKNOWN — nothing; the game does not even tell your client it exists. CONTACT — a hollow dashed "?" blip: something is at that grid, and that is all, e.g. "CONTACT · Unknown Enemy · Grid F-42 · Confidence 58%". IDENTIFIED — a dashed counter with the arm and a "?" badge: enemy infantry, say, but not which battalion and not how strong. CONFIRMED — a solid counter with a "✓" badge and the real designation. Confidence rises with closer, clearer and repeated observation (once per round), and with recon assets; it decays every round once you lose sight, sliding a Confirmed formation back down to a stale last-known-position marker. Attacking something you have only made Contact with costs you 40% of your combat power; Identified costs 12%; Confirmed costs nothing.',
  },
  {
    title: 'Recon vs normal spotting',
    body: 'Ordinary troops detect nearby enemies. Recon sees further, sooner, and knows what it is looking at. The R order is worth its AP because it does five things passive spotting does not: it uses a much longer sensor range (14 tiles for C4I, 11 for commandos, against 9 and 7 passively), it pushes through forest and built-up ground instead of being stopped by it, it adds a flat confidence bonus that jumps contacts up the ladder in one go, it marks what it finds as recon-tracked so those contacts decay far more slowly, and it re-fixes stale contacts you are about to lose. A Special Op by the commandos (6 tiles) or the Guards (4 tiles) can also probe behind the lines and confirm whatever is around the objective it lands on.',
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
