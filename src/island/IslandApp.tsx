import { useState } from 'react';
import { sound } from '../audio/sound';
import { newGame } from './engine';
import { FACTIONS, FACTION_IDS, GameState } from './types';
import { GameScreen } from './ui/GameScreen';
import { Setup, TitleScreen } from './ui/TitleScreen';

const SETUP_KEY = 'island_ops_setup_v2';

const DEFAULT_SETUP: Setup = { faction: 'SINGA', opponents: 3, level: 'REGULAR' };

function loadSetup(): Setup {
  try {
    const raw = localStorage.getItem(SETUP_KEY);
    if (raw) {
      const saved = { ...DEFAULT_SETUP, ...JSON.parse(raw) } as Setup;
      // A setup saved before the roster changed may name a retired service or too many seats.
      if (!FACTIONS[saved.faction]) saved.faction = DEFAULT_SETUP.faction;
      saved.opponents = Math.min(Math.max(saved.opponents, 2), FACTION_IDS.length - 1);
      return saved;
    }
  } catch {
    // Storage unavailable — fall through to defaults.
  }
  return DEFAULT_SETUP;
}

function start(setup: Setup): GameState {
  const others = FACTION_IDS.filter((f) => f !== setup.faction);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  return newGame({ human: setup.faction, factions: [setup.faction, ...others.slice(0, setup.opponents)] });
}

export default function IslandApp() {
  const [setup, setSetup] = useState<Setup>(loadSetup);
  const [game, setGame] = useState<GameState | null>(null);

  const begin = (s: Setup) => {
    setSetup(s);
    try {
      localStorage.setItem(SETUP_KEY, JSON.stringify(s));
    } catch {
      // Not persisted this time; harmless.
    }
    sound.unlock();
    setGame(start(s));
  };

  if (!game) return <TitleScreen initial={setup} onStart={begin} />;
  return <GameScreen key={game.seed} initial={game} level={setup.level} onExit={() => setGame(null)} onRestart={() => setGame(start(setup))} />;
}
