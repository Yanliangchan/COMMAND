import { useState } from 'react';
import { sound } from '../audio/sound';
import { BotLevel, LEVEL_HANDICAP } from './bot';
import { newGame } from './engine';
import { FACTION_IDS, FactionId, GameState, Order } from './types';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { GameScreen } from './ui/GameScreen';
import { clearMatch, loadMatch } from './ui/save';
import { Setup, TitleScreen } from './ui/TitleScreen';

const SETUP_KEY = 'island_ops_setup_v2';
const LEVELS: BotLevel[] = ['RECRUIT', 'REGULAR', 'VETERAN'];

export const DEFAULT_SETUP: Setup = { faction: 'SINGA', opponents: 3, level: 'REGULAR' };

/** A saved setup, field by field against what's allowed — anything else falls back to the default. */
export function parseSetup(raw: string | null): Setup {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return DEFAULT_SETUP;
    return {
      faction: FACTION_IDS.includes(v.faction) ? (v.faction as FactionId) : DEFAULT_SETUP.faction,
      opponents: v.opponents === 2 || v.opponents === 3 ? v.opponents : DEFAULT_SETUP.opponents,
      level: LEVELS.includes(v.level) ? (v.level as BotLevel) : DEFAULT_SETUP.level,
    };
  } catch {
    return DEFAULT_SETUP;
  }
}

function loadSetup(): Setup {
  try {
    return parseSetup(localStorage.getItem(SETUP_KEY));
  } catch {
    return DEFAULT_SETUP;
  }
}

function start(setup: Setup): GameState {
  const others = FACTION_IDS.filter((f) => f !== setup.faction);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const bots = others.slice(0, setup.opponents);
  return newGame({
    human: setup.faction,
    factions: [setup.faction, ...bots],
    handicaps: Object.fromEntries(bots.map((f) => [f, LEVEL_HANDICAP[setup.level]])),
  });
}

interface Match {
  game: GameState;
  level: BotLevel;
  draft: Order[];
}

export default function IslandApp() {
  const [setup, setSetup] = useState<Setup>(loadSetup);
  const [match, setMatch] = useState<Match | null>(null);
  const [saved, setSaved] = useState(loadMatch);

  const begin = (s: Setup) => {
    const game = start(s);
    setSetup(s);
    try {
      localStorage.setItem(SETUP_KEY, JSON.stringify(s));
    } catch {
      // Not persisted this time; harmless.
    }
    sound.unlock();
    clearMatch();
    setMatch({ game, level: s.level, draft: [] });
  };

  const resume = () => {
    const m = loadMatch();
    if (!m) return setSaved(null);
    sound.unlock();
    setMatch(m);
  };

  const exit = () => {
    setMatch(null);
    setSaved(loadMatch());
  };

  if (!match) return <TitleScreen initial={setup} onStart={begin} saved={saved} onResume={resume} />;
  return (
    <ErrorBoundary onReset={exit}>
      <GameScreen
        key={match.game.seed}
        initial={match.game}
        level={match.level}
        initialDraft={match.draft}
        onExit={exit}
        onRestart={() => begin({ ...setup, level: match.level })}
      />
    </ErrorBoundary>
  );
}
