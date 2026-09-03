import React, { useState } from 'react';
import { Marker, TutorialDiagram } from './TutorialDiagram';

interface Section {
  id: string;
  nav: string;
  title: string;
  render: () => React.ReactNode;
}

const K = ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>;

const SECTIONS: Section[] = [
  {
    id: 'basics',
    nav: 'The loop',
    title: 'The basic loop',
    render: () => (
      <>
        <p className="tut-lede">
          Select a unit, see what it can do, give the order, repeat. That is the whole game — everything else is judgement about
          where and when.
        </p>
        <ol className="tut-steps">
          <li>
            <b>Click one of your formations</b> on the map, or a row in the roster on the left.
          </li>
          <li>
            <b>Its orders appear at the bottom of the screen</b>, each with its key: <K>M</K> Move, <K>A</K> Attack, <K>R</K> Recon,{' '}
            <K>F</K> Fortify, <K>S</K> Resupply.
          </li>
          <li>
            <b>Click the order</b> (or press the key), then click the tile or enemy you mean. <K>Esc</K> cancels.
          </li>
          <li>
            When nobody has anything useful left, <b>end the turn</b> with <K>E</K>.
          </li>
        </ol>
        <p>
          Two budgets limit you. <b>Action Points</b> are shared across your whole force and refresh every turn. <b>Movement
          actions</b> are per formation — most units may move twice a round, scouts three times, artillery once.
        </p>
        <p className="tut-tip">
          Press <K>Tab</K> at any time to jump to the next formation that still has orders available.
        </p>
      </>
    ),
  },
  {
    id: 'movement',
    nav: 'Movement',
    title: 'Movement — press M',
    render: () => {
      const markers: Marker[] = [
        { x: 1, y: 1, kind: 'move' },
        { x: 2, y: 1, kind: 'move' },
        { x: 3, y: 1, kind: 'move' },
        { x: 1, y: 2, kind: 'move' },
        { x: 3, y: 2, kind: 'move' },
        { x: 1, y: 3, kind: 'move' },
        { x: 2, y: 3, kind: 'move' },
        { x: 5, y: 2, kind: 'move' },
        { x: 6, y: 2, kind: 'move' },
        { x: 2, y: 2, kind: 'blue', text: 'AR' },
      ];
      return (
        <>
          <p className="tut-lede">
            Move repositions a formation. Press <K>M</K>, then hover a tile — the preview names the grid reference, the
            distance, the going, the road bonus and how many movement actions the bound costs — then click to commit.
          </p>
          <TutorialDiagram
            rows={['..ggg..r', '.gg.fg.r', '.g..g..r', '.gffg..r']}
            markers={markers}
            caption="Amber tiles are within reach for this move. Forest costs more to enter, so the range bulges along the open grass and stretches far down the road on the right."
          />
          <ul className="tut-list">
            <li>
              <b>Terrain sets the cost.</b> Open ground and grass are cheap, forest and hills expensive, climbing uphill
              costs extra — and roads are much cheaper than any of it. Infantry cover 4 tiles cross-country but 6 along a
              road; armour, artillery, engineers and recce roughly double their reach on one.
            </li>
            <li>
              <b>Water stops land units</b> unless there is a bridge. Ships may only travel on navigable water.
            </li>
            <li>
              <b>You may move more than once a round.</b> The unit card publishes both numbers — "Movement: 4 tiles" and
              "Movement Actions: 2 / 2", dropping to "1 / 2" once you have moved. Move, fight, then move again to break
              contact.
            </li>
            <li>
              <b>Move a whole formation at once.</b> Shift-click two or more of your units, then press <K>⇧M</K> and pick a
              destination. They advance together at the slowest one's pace — that is how you keep 40 SAR, 21 SA and 35 SCE
              in the same fight instead of strung out across the sheet.
            </li>
            <li>
              A destination that will not work always tells you why — too far, terrain impassable, enemy-controlled — and if a
              support element is about to be left behind you get an advisory, not a veto.
            </li>
            <li>Moving cancels a dug-in position, and a tired or unsupplied formation covers less ground (the unit card says so).</li>
          </ul>
        </>
      );
    },
  },
  {
    id: 'attack',
    nav: 'Attack',
    title: 'Attack — press A',
    render: () => {
      const markers: Marker[] = [
        { x: 2, y: 1, kind: 'attack' },
        { x: 1, y: 2, kind: 'attack' },
        { x: 3, y: 2, kind: 'attack' },
        { x: 2, y: 3, kind: 'attack' },
        { x: 2, y: 2, kind: 'blue', text: 'IN' },
        { x: 3, y: 2, kind: 'red', text: 'IN' },
        { x: 6, y: 1, kind: 'red', text: 'TY' },
      ];
      return (
        <>
          <p className="tut-lede">
            Attack engages an enemy formation. Press <K>A</K>, then click an enemy inside your attack range — they are ringed in
            red dashes.
          </p>
          <TutorialDiagram
            rows={['.g.gguug', 'gg.ffuug', '..g.gg.g', '.gg.g..g']}
            markers={markers}
            caption="Most units must be adjacent to attack. The enemy artillery two tiles away is out of reach until you close the distance — or bring your own guns."
          />
          <ul className="tut-list">
            <li>
              <b>Requirements:</b> it is your turn, the formation has not used its major action yet, you have the AP, and a visible
              enemy is inside range. Anything missing greys the button out and says why.
            </li>
            <li>
              <b>Range varies.</b> Infantry, armour and commandos fight adjacent. Artillery reaches eight tiles with a Fire
              Mission (<K>G</K>); ships shell the coast from three or four.
            </li>
            <li>
              <b>Terrain decides the outcome as much as strength.</b> A defender in a town, forest or on a hill is far harder to
              beat than the same unit on open ground or a beach.
            </li>
            <li>
              <b>Only a close assault takes ground.</b> Long-range fire hurts the enemy but never occupies their tile.
            </li>
          </ul>
        </>
      );
    },
  },
  {
    id: 'recon',
    nav: 'Recon',
    title: 'Recon — press R',
    render: () => {
      const markers: Marker[] = [
        { x: 1, y: 0, kind: 'recon' },
        { x: 2, y: 0, kind: 'recon' },
        { x: 3, y: 0, kind: 'recon' },
        { x: 0, y: 1, kind: 'recon' },
        { x: 1, y: 1, kind: 'recon' },
        { x: 2, y: 1, kind: 'recon' },
        { x: 3, y: 1, kind: 'recon' },
        { x: 4, y: 1, kind: 'recon' },
        { x: 1, y: 2, kind: 'recon' },
        { x: 2, y: 2, kind: 'recon' },
        { x: 3, y: 2, kind: 'recon' },
        { x: 2, y: 1, kind: 'blue', text: 'RC' },
        { x: 4, y: 1, kind: 'red', text: 'AR' },
        { x: 6, y: 2, kind: 'ghost' },
      ];
      return (
        <>
          <p className="tut-lede">
            <b>Recon means gathering information about enemy forces.</b> Use Recon to reveal hidden units and improve your
            understanding of the battlefield. Press <K>R</K> — no target needed, it sweeps everything around the unit.
          </p>
          <TutorialDiagram
            rows={['.ggfg.g.', 'g.g.gg..', '.gg.ffg.', 'gg..g.gg']}
            markers={markers}
            caption="Inside the sweep the enemy armour becomes a solid, trustworthy marker. Outside it, all you have is a dashed '?' — a contact from an earlier sighting."
          />
          <ul className="tut-list">
            <li>
              <b>Fog of war:</b> you only see what your formations can see. Everything else is either unknown or remembered.
            </li>
            <li>
              <b>Unknown contacts</b> are the dashed circles with a "?". They show where something <i>was</i>. Their confidence
              decays each round — an old contact may have moved, or may not be what you think.
            </li>
            <li>
              <b>Recon range beats sight range.</b> Every unit sees a little; a Recon (C4I/ISR) formation sweeps eight tiles, and
              commandos six.
            </li>
            <li>
              <b>Recon pays off in combat.</b> Attacking a target you have properly identified is materially more effective than
              attacking blind.
            </li>
          </ul>
        </>
      );
    },
  },
  {
    id: 'fortify',
    nav: 'Fortify',
    title: 'Fortify — press F',
    render: () => {
      const markers: Marker[] = [
        { x: 2, y: 1, kind: 'fortify' },
        { x: 2, y: 1, kind: 'blue', text: 'IN' },
        { x: 5, y: 1, kind: 'blue', text: 'IN' },
        { x: 3, y: 1, kind: 'red', text: 'AR' },
      ];
      return (
        <>
          <p className="tut-lede">Fortify digs the formation in. It defends much better until it moves again.</p>
          <TutorialDiagram
            rows={['.gguug.g', 'gguuug.g', '.g.gg..g', 'gg.g..gg']}
            markers={markers}
            caption="The dug-in battalion in the town (amber arc) is a far harder target than the identical battalion sitting in the open two tiles away."
          />
          <ul className="tut-list">
            <li>
              <b>When to fortify:</b> you have taken an objective and intend to keep it; you are the weaker force and want the
              enemy to come to you; you are holding a bridge, a ridge or a town.
            </li>
            <li>
              <b>The benefit stacks with terrain.</b> Dug in, in a town, on high ground is the strongest defensive position in the
              game.
            </li>
            <li>
              <b>It costs you initiative.</b> Fortifying spends the formation's major action, and moving throws the position away.
            </li>
          </ul>
        </>
      );
    },
  },
  {
    id: 'combined',
    nav: 'Combined arms',
    title: 'Combined arms',
    render: () => {
      const markers: Marker[] = [
        { x: 3, y: 1, kind: 'attack' },
        { x: 1, y: 1, kind: 'blue', text: 'RC' },
        { x: 2, y: 1, kind: 'blue', text: 'AR' },
        { x: 2, y: 2, kind: 'blue', text: 'IN' },
        { x: 0, y: 2, kind: 'blue', text: 'TY' },
        { x: 3, y: 1, kind: 'red', text: 'IN' },
        { x: 6, y: 3, kind: 'blue', text: 'IN' },
        { x: 7, y: 3, kind: 'red', text: 'AR' },
      ];
      return (
        <>
          <p className="tut-lede">
            One formation attacking alone is a bad trade. Four arms working on the same objective are worth far more than four
            separate attacks.
          </p>
          <TutorialDiagram
            rows={['ggg.g.gg', 'gg.fgg.g', '.gg.gg.g', 'gg.gg.gg']}
            markers={markers}
            caption="Left: recon has identified the target, artillery softens it, armour leads the assault and infantry supports from an adjacent tile. Right: a lone battalion walking into enemy armour."
          />
          <ul className="tut-list">
            <li>
              <b>Recon first.</b> Identify the target so your attack is not blind, and so you know what is really there.
            </li>
            <li>
              <b>Artillery and air strikes soften.</b> They cannot take ground, so use them to cut strength and morale before the
              assault.
            </li>
            <li>
              <b>Armour leads in the open; infantry leads into towns and forests.</b> Attacking with the wrong arm for the ground
              is how good forces lose.
            </li>
            <li>
              <b>Keep friendly units adjacent.</b> Supporting formations nearby measurably improve your odds, and give you
              somewhere to fall back to.
            </li>
            <li>
              <b>Engineers unlock the map</b> — a bridge across a river turns an impossible flank into an obvious one.
            </li>
          </ul>
        </>
      );
    },
  },
  {
    id: 'objectives',
    nav: 'Objectives',
    title: 'Objectives and winning',
    render: () => {
      const markers: Marker[] = [
        { x: 2, y: 1, kind: 'objective' },
        { x: 2, y: 1, kind: 'blue', text: 'IN' },
        { x: 6, y: 2, kind: 'objective' },
        { x: 5, y: 2, kind: 'red', text: 'AR' },
      ];
      return (
        <>
          <p className="tut-lede">
            You do not win by killing everything. You win on <b>Victory Points</b>, and VP come from holding ground.
          </p>
          <TutorialDiagram
            rows={['.gguug.g', 'gguuug.g', '.g.ggwbg', 'gg.g.wbg']}
            markers={markers}
            caption="Left: the town district is occupied and paying VP every round. Right: an uncontested objective the enemy is one move away from taking."
          />
          <ul className="tut-list">
            <li>
              <b>Capture by occupying.</b> Move a formation onto the objective tile; control transfers to you and stays until
              someone takes it back.
            </li>
            <li>
              <b>Every objective pays each round you hold it.</b> Urban districts pay the most; bridges, ports, airfields, depots
              and anchorages pay less but matter strategically.
            </li>
            <li>
              <b>Anchorages are maritime</b> — only a ship can hold one.
            </li>
            <li>
              <b>Ports, airfields and depots also project supply.</b> Formations outside your supply range lose readiness and
              cannot resupply.
            </li>
            <li>
              <b>Winning:</b> first side to 200 VP wins immediately; otherwise the higher score after 24 rounds takes the
              operation.
            </li>
          </ul>
        </>
      );
    },
  },
];

export const Tutorial: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [active, setActive] = useState(0);
  const section = SECTIONS[active];
  return (
    <div className="modal-backdrop tutorial-backdrop">
      <div className="tutorial" data-testid="tutorial">
        <div className="tutorial-head">
          <div>
            <div className="tutorial-kicker">COMMAND — FIELD TRAINING</div>
            <div className="tutorial-title">{section.title}</div>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close the tutorial">
            ✕
          </button>
        </div>
        <div className="tutorial-body">
          <nav className="tutorial-nav">
            {SECTIONS.map((s, i) => (
              <button key={s.id} className={i === active ? 'on' : ''} onClick={() => setActive(i)} data-testid={`tut-nav-${s.id}`}>
                <span className="tut-step-no">{i + 1}</span>
                {s.nav}
              </button>
            ))}
          </nav>
          <div className="tutorial-content" data-testid="tutorial-content">
            {section.render()}
          </div>
        </div>
        <div className="tutorial-foot">
          <button className="btn-ghost tut-nav-btn" disabled={active === 0} onClick={() => setActive((a) => Math.max(0, a - 1))}>
            ← Back
          </button>
          <span className="tut-progress">
            {active + 1} / {SECTIONS.length}
          </span>
          {active < SECTIONS.length - 1 ? (
            <button className="btn-primary tut-nav-btn" onClick={() => setActive((a) => a + 1)}>
              Next →
            </button>
          ) : (
            <button className="btn-primary tut-nav-btn" onClick={onClose}>
              Start playing
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
