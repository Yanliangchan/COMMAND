import { useCallback, useState } from 'react';
import { sound } from '../audio/sound';
import { BotLevel, planBot } from './bot';
import { alive, newGame, recon, resolveRound, submitOrders, validateOrders, viewFor } from './engine';
import { useIslandOnline } from './net';
import { FACTIONS, FACTION_IDS, FactionId, GameState, Order, PlayerView, RoundReport } from './types';
import { GameScreen } from './ui/GameScreen';
import { Lobby } from './ui/Lobby';
import { Setup, TitleScreen } from './ui/TitleScreen';

const SETUP_KEY = 'island_ops_setup_v2';

const DEFAULT_SETUP: Setup = { faction: 'SINGA', opponents: 3, level: 'REGULAR', name: '' };

function loadSetup(): Setup {
  try {
    const raw = localStorage.getItem(SETUP_KEY);
    if (raw) {
      const saved = { ...DEFAULT_SETUP, ...JSON.parse(raw) } as Setup;
      // A setup saved before the roster changed may name a retired side or too many seats.
      if (!FACTIONS[saved.faction]) saved.faction = DEFAULT_SETUP.faction;
      saved.opponents = Math.min(Math.max(saved.opponents, 2), FACTION_IDS.length - 1);
      return saved;
    }
  } catch {
    // Storage unavailable — fall through to defaults.
  }
  return DEFAULT_SETUP;
}

function saveSetup(s: Setup) {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(s));
  } catch {
    // Not persisted this time; harmless.
  }
}

function startLocal(setup: Setup): GameState {
  const others = FACTION_IDS.filter((f) => f !== setup.faction);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  return newGame({ human: setup.faction, factions: [setup.faction, ...others.slice(0, setup.opponents)] });
}

/** Single player: the whole game lives here, and the bots plan the instant you're ready. */
function LocalMatch({ initial, level, onExit, onRestart }: { initial: GameState; level: BotLevel; onExit: () => void; onRestart: () => void }) {
  const [game, setGame] = useState(initial);
  const [pending, setPending] = useState<{ report: RoundReport; before: PlayerView } | null>(null);
  const me = game.factions.find((f) => game.players[f]!.human) as FactionId;

  const onRecon = useCallback(
    async (region: string) => {
      try {
        setGame(recon(game, me, region));
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
    [game, me],
  );

  const onSubmit = useCallback(
    async (orders: Order[]) => {
      const err = validateOrders(game, me, orders);
      if (err) return err;
      let s = submitOrders(game, me, orders);
      for (const f of alive(s)) {
        if (f === me) continue;
        const botOrders = planBot(
          () => viewFor(s, f),
          (r) => (s = recon(s, f, r)),
          level,
        );
        s = submitOrders(s, f, botOrders);
      }
      const before = viewFor(s, me);
      const { state, report } = resolveRound(s);
      setGame(state);
      setPending({ report, before });
      return null;
    },
    [game, me, level],
  );

  return (
    <GameScreen
      view={viewFor(game, me)}
      pending={pending}
      onPlayed={() => setPending(null)}
      submitted={false}
      onRecon={onRecon}
      onSubmit={onSubmit}
      onExit={onExit}
      onRestart={onRestart}
    />
  );
}

export default function IslandApp() {
  const [setup, setSetup] = useState<Setup>(loadSetup);
  const [local, setLocal] = useState<GameState | null>(null);
  const online = useIslandOnline();
  const joinCode = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? undefined;

  const remember = (s: Setup) => {
    setSetup(s);
    saveSetup(s);
    sound.unlock();
  };

  if (local) return <LocalMatch key={local.seed} initial={local} level={setup.level} onExit={() => setLocal(null)} onRestart={() => setLocal(startLocal(setup))} />;

  if (online.status === 'playing' && online.view)
    return (
      <GameScreen
        view={online.view}
        pending={online.pending}
        onPlayed={online.played}
        submitted={online.submitted}
        onRecon={online.recon}
        onSubmit={online.submit}
        onUnready={online.unready}
        seats={online.lobby?.seats}
        deadline={online.lobby?.deadline ?? null}
        notice={online.notice}
        emotes={online.emotes}
        onEmote={online.emote}
        roomCode={online.code ?? undefined}
        onExit={online.leave}
      />
    );

  if ((online.status === 'lobby' || online.status === 'connecting' || online.status === 'closed') && (online.lobby || online.status !== 'connecting'))
    return <Lobby online={online} />;

  return (
    <TitleScreen
      initial={setup}
      joinCode={joinCode}
      busy={online.status === 'connecting'}
      notice={online.notice}
      onStart={(s) => {
        remember(s);
        setLocal(startLocal(s));
      }}
      onCreateOnline={(s) => {
        remember(s);
        online.create(s.name || 'Commander', s.faction, (s.opponents + 1) as 3 | 4, s.level);
      }}
      onJoinOnline={(code, s) => {
        remember(s);
        online.join(code, s.name || 'Commander');
      }}
    />
  );
}
