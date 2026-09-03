import React, { useEffect, useState } from 'react';
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
            <K>F</K> Fortify.
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
          actions</b> are per formation — most units may move twice a round and the fast ones three times.
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
            <li>Moving cancels a dug-in position, and a formation whose readiness has fallen below 50% covers less ground (the unit card says so).</li>
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
              <b>Read the prediction before you commit.</b> Hover a target with <K>A</K> armed and a panel appears: the likely
              outcome, the strength both sides expect to lose, your share of the combat power, and every factor for and
              against you. The battle report afterwards is the same panel with the dice filled in — if you can read one you
              can predict the other.
            </li>
            <li>
              <b>Range varies.</b> Infantry, armour, commandos and Guards fight adjacent. Artillery reaches seven tiles with a
              Fire Mission (<K>G</K>); a frigate engages out to nine and a littoral squadron to six.
            </li>
            <li>
              <b>Terrain and the matchup decide the outcome as much as strength.</b> A defender in a town, forest or on a hill
              is far harder to shift — and armour attacking into that town fights at 0.70 while infantry attacking the same
              town fight at full weight. Bring the right arm for the ground.
            </li>
            <li>
              <b>Attacking always costs you something.</b> Losses are shared out in proportion to combat power: an even fight
              takes about 13% off both sides. There is no free attack, only a good trade.
            </li>
            <li>
              <b>Only a close assault takes ground.</b> Long-range fire — guns and ships — hurts the enemy badly at almost no
              risk to itself, but it never occupies their tile.
            </li>
            <li>
              <b>A formation reduced to 0 strength is destroyed.</b> A brief cross-marker flashes at the spot for both sides
              and the log names it — capped, for the side that did not own it, at whatever that side's own detection had
              actually established.
            </li>
          </ul>
        </>
      );
    },
  },
  {
    id: 'overwatch',
    nav: 'Overwatch & ZOC',
    title: 'Overwatch, Zones of Control & suppression',
    render: () => {
      const markers: Marker[] = [
        { x: 1, y: 1, kind: 'blue', text: 'IN' },
        { x: 3, y: 1, kind: 'red', text: 'AR' },
        { x: 2, y: 1, kind: 'attack' },
        { x: 2, y: 2, kind: 'attack' },
        { x: 4, y: 1, kind: 'attack' },
        { x: 3, y: 0, kind: 'attack' },
      ];
      return (
        <>
          <p className="tut-lede">
            Three related battlefield conditions, none of them costing you an order to benefit from: a formation you leave
            idle can bite back, ground next to the enemy is dangerous to cross, and heavy fire leaves a unit rattled even
            when it survives.
          </p>
          <TutorialDiagram
            rows={['ggg.g.gg', 'gg.fgg.g', '.gg.gg.g', 'gg.gg.gg']}
            markers={markers}
            caption="The armour battalion's Zone of Control (red-hatched in the real game) covers the tiles around it — the infantry battalion two tiles off would have its move stopped the moment it entered one."
          />
          <ul className="tut-list">
            <li>
              <b>Overwatch.</b> End a formation's turn WITHOUT spending its major action (it may still have moved) and it
              goes ON ALERT for the opponent's next turn — a pulsing red ring on the map, a badge on its unit card. If an
              enemy formation moves into its weapons range and its detection range and line of sight, it fires ONE
              reduced-power reaction shot at no AP cost — the reward for holding rather than acting. One shot per alert
              formation per opponent turn; artillery never stands overwatch.
            </li>
            <li>
              <b>Zones of Control.</b> Every land formation except artillery projects one into its four adjacent tiles,
              shown automatically while Move is armed. An enemy MOVING THROUGH one of your ZOC tiles has its bound end
              there — it can stop on the tile, but not use it as a step to somewhere further. Breaking contact by leaving
              a ZOC tile you started in costs a full movement action's worth of points, and the movement preview itemises
              the surcharge before you commit.
            </li>
            <li>
              <b>Suppression.</b> Artillery, naval standoff fire and air strikes apply a heavy dose (30), a direct assault a
              smaller amount too (12) — shown as its own purple bar, separate from strength, morale and readiness. It cuts
              the suppressed formation's own attack power and movement range, up to -50% at maximum, and never causes
              strength loss by itself. It decays 25 points a round left alone — faster in cover or dug in, slower in the
              open — and the pre-attack preview shows how much an engagement will apply before you commit.
            </li>
          </ul>
        </>
      );
    },
  },
  {
    id: 'recon',
    nav: 'Spotting',
    title: 'Spotting & Recon — press R',
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
            <b>You do not need an order to see the enemy.</b> Every formation watches its surroundings continuously and for
            free: if it has line of sight and an enemy comes inside its detection range, you spot it — on your turn or in the
            middle of the opponent's. <K>R</K> is what makes you see <i>further</i>, <i>sooner</i>, and with <i>certainty</i>.
          </p>
          <TutorialDiagram
            rows={['.ggfg.g.', 'g.g.gg..', '.gg.ffg.', 'gg..g.gg']}
            markers={markers}
            caption="The amber area is what this recce battalion picks up on its own, with no AP spent. A Recon sweep reaches much further still, pushes through the wood on the right, and turns a '?' blip into a named formation."
          />
          <ul className="tut-list">
            <li>
              <b>Detection range depends on the formation.</b> Recon (C4I / ISR) about 9 tiles, commandos 7, warships 7–8,
              infantry and armour 5, engineers 4, artillery 3. Move a battalion next to an enemy in the open and you will
              always see it — no order required.
            </li>
            <li>
              <b>Terrain and height change that range in both directions.</b> Standing on a hill or in open ground extends
              your picture (×1.35 / ×1.15); sitting in a wood or a housing estate cuts it roughly in half. The same terrain
              hides the enemy: a battalion in a town is found at about half the distance it would be on a beach.
            </li>
            <li>
              <b>Sight is a ray, not a circle.</b> The game walks the height profile between you and the target — higher
              ground in between closes the line completely, and forest and city fabric pile up haze that shortens it. A unit
              on a ridge sees <i>over</i> the low ground; a unit in a valley wood is nearly blind.
            </li>
            <li>
              <b>Four detection states.</b> Nothing at all (Unknown) · a hollow dashed "?" blip with a grid reference and a
              confidence, e.g. "CONTACT · Unknown Enemy · Grid F-42 · Confidence 58%" · a dashed counter that names the arm
              ("IDENTIFIED · Enemy Infantry · 91%") · and a solid "✓" counter with the real designation (Confirmed).
            </li>
            <li>
              <b>Confidence rises and falls.</b> Closer, clearer and repeated observation climbs the ladder — once per round,
              so sustained watching is what confirms a formation. Lose sight and confidence decays every round until a
              Confirmed battalion is back to a stale last-known-position marker, then nothing.
            </li>
            <li>
              <b>What Recon buys you.</b> A much longer sensor range, the ability to see through cover, a flat confidence
              bonus that jumps contacts up the ladder in one go, contacts that decay far more slowly once tracked, and a
              re-fix on the stale contacts you are about to lose. Normal troops detect nearby enemies; recon sees further,
              sooner, and knows what it is looking at.
            </li>
            <li>
              <b>What recon is worth: certainty, not firepower.</b> Attacking a formation you have only identified does not
              weaken your attack one bit — if you can see it well enough to engage it, you fight just as well. What you lose
              is the ability to know what you are walking into: the pre-attack preview has to guess at the target's strength,
              its morale and whether it is dug in, so it shows a wide band and says so. Confirm the target first and the same
              panel gives you a tight, reliable prediction. Recon buys you the plan, not the punch.
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
            <li>
              <b>Reorganize (S) is the other stand-down order</b> — recovers readiness, morale and a little strength instead
              of defence. It needs the formation to have made no movement action this round, and it cannot be used again for
              three rounds, so it cannot be spammed to erase what combat cost you.
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
              <b>Recon first.</b> Confirm the target so the pre-attack preview is a prediction rather than a guess — you will
              often find the fight you were about to pick is not the one you thought.
            </li>
            <li>
              <b>Artillery, warships and air strikes soften.</b> They cannot take ground, so use them to cut strength and morale
              before the assault. Guns and ships carry only three or four rounds and get one back per round they hold their
              fire, so pick the moment.
            </li>
            <li>
              <b>Armour leads in the open; infantry leads into towns and forests.</b> Attacking with the wrong arm for the ground
              is how good forces lose.
            </li>
            <li>
              <b>Keep friendly units adjacent.</b> Each different friendly arm next to your attacker adds 7% to its power, up
              to 21%, and each friendly next to a defender adds 5% to its resistance, up to 15%. It is itemised in the
              preview, so you can see the bonus before you spend the AP.
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
            caption="Left: the town district is occupied and paying VP every round it survives the enemy's reply. Right: an objective the enemy is one move away from taking back."
          />
          <ul className="tut-list">
            <li>
              <b>Capture by occupying.</b> Move a formation onto the objective tile; control transfers to you and stays until
              someone takes it back.
            </li>
            <li>
              <b>You are paid for what you are still holding after the enemy's reply</b>, not for what you touched. Ground you
              seize and then lose again before your opponent finishes their turn scores nothing at all.
            </li>
            <li>
              <b>The middle is where the points are.</b> Objectives on the axis between the two deployment areas — the towns, the
              trunk river crossings, the commanding hills — are worth two to three times a rear-area objective. Sitting on your
              own back yard cannot win the operation inside the round limit.
            </li>
            <li>
              <b>Anchorages are maritime</b> — only a ship can hold one.
            </li>
            <li>
              <b>Winning:</b> first task force to 280 VP wins immediately; otherwise the higher score after 24 rounds takes the
              operation.
            </li>
          </ul>
        </>
      );
    },
  },
  {
    id: 'interface',
    nav: 'The HUD',
    title: 'Briefings, notifications and sound',
    render: () => (
      <>
        <p className="tut-lede">A few small pieces of the interface exist purely to keep you oriented — none of them cost AP.</p>
        <ul className="tut-list">
          <li>
            <b>Pre-battle briefing.</b> Every match opens on a short task order — who you command, who you are up against, the
            victory condition, and a side-by-side of both rosters' arm counts. Click <b>Begin</b> or press <K>Enter</K>/<K>Esc</K>{' '}
            to jump straight into it; it dismisses on its own after a few seconds either way.
          </li>
          <li>
            <b>SITREP banner.</b> At the start of each of your turns, a one-line summary fades in across the top of the screen —
            new contacts, objectives that changed hands, formations lost or destroyed, artillery that rearmed — everything that
            happened while it was not your turn. Click it to dismiss it early.
          </li>
          <li>
            <b>Jump notifications.</b> The amber banner near the top of the map is clickable and centres the camera on whatever
            it is reporting — a new contact, a kill, or an objective change. Several events landing at once are folded into one
            banner rather than one each.
          </li>
          <li>
            <b>Sound.</b> The <i>Sound</i> control in the top-right toolbar mutes or sets the volume of the game's short
            synthesized cues (movement, weapons fire, contacts, objective capture, turn changes) — your choice is remembered on
            this device. Sound only ever plays for something your own side has actually detected.
          </li>
        </ul>
      </>
    ),
  },
];

export const Tutorial: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [active, setActive] = useState(0);
  const section = SECTIONS[active];

  // Self-contained keyboard handling: Escape closes the tutorial and
  // Left/Right step between sections. This modal is reachable from the
  // landing page, before any game exists, so it cannot rely on the in-game
  // App-level shortcut handler (which only runs once a game is joined) —
  // and stopping propagation here means that IF it is ever opened over a
  // live game in the future, its own keys can never leak through to arm a
  // game action underneath it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowRight' && active < SECTIONS.length - 1) {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => Math.min(SECTIONS.length - 1, a + 1));
        return;
      }
      if (e.key === 'ArrowLeft' && active > 0) {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => Math.max(0, a - 1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, onClose]);

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
