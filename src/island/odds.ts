// ============================================================================
// ISLAND OPS — exact battle odds.
//
// Enumerates every dice outcome for one roll, then runs a small dynamic
// programme over (attacker troops, defender troops) to get the chance a Blitz
// ends in a capture. Same rules as engine.resolveBattle: attacker rolls up to
// `maxDice` (leaving one troop behind), defender up to 2, highest pairs
// compared, ties to the defender, a stronghold adds +1 to the defender's best.
// ============================================================================

interface RollOutcome {
  atkLoss: number;
  defLoss: number;
  p: number;
}

const rollCache = new Map<string, RollOutcome[]>();

/** Every way one exchange of `nA` vs `nD` dice can end, with its probability. */
export function rollOutcomes(nA: number, nD: number, stronghold: boolean): RollOutcome[] {
  const key = `${nA}/${nD}/${stronghold ? 1 : 0}`;
  const hit = rollCache.get(key);
  if (hit) return hit;
  const tally = new Map<string, number>();
  const total = 6 ** (nA + nD);
  const dice = new Array(nA + nD).fill(1);
  for (let n = 0; n < total; n++) {
    let x = n;
    for (let i = 0; i < dice.length; i++) {
      dice[i] = (x % 6) + 1;
      x = Math.floor(x / 6);
    }
    const atk = dice.slice(0, nA).sort((a, b) => b - a);
    const def = dice.slice(nA).sort((a, b) => b - a);
    if (stronghold) def[0] += 1;
    let aL = 0, dL = 0;
    for (let i = 0; i < Math.min(nA, nD); i++) {
      if (atk[i] > def[i]) dL++;
      else aL++;
    }
    const k = `${aL}/${dL}`;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  const out = [...tally].map(([k, c]) => {
    const [atkLoss, defLoss] = k.split('/').map(Number);
    return { atkLoss, defLoss, p: c / total };
  });
  rollCache.set(key, out);
  return out;
}

const blitzCache = new Map<string, number>();

/**
 * Chance that blitzing from a region holding `attackers` troops into one
 * holding `defenders` ends in a capture. The attacker always keeps one troop
 * home, so a region with 1 troop can't attack at all.
 */
export function captureChance(attackers: number, defenders: number, stronghold: boolean, maxDice = 3): number {
  if (defenders <= 0) return 1;
  if (attackers < 2) return 0;
  const key = `${attackers}/${defenders}/${stronghold ? 1 : 0}/${maxDice}`;
  const hit = blitzCache.get(key);
  if (hit !== undefined) return hit;
  const nA = Math.min(maxDice, attackers - 1);
  const nD = Math.min(2, defenders);
  let p = 0;
  for (const o of rollOutcomes(nA, nD, stronghold)) p += o.p * captureChance(attackers - o.atkLoss, defenders - o.defLoss, stronghold, maxDice);
  blitzCache.set(key, p);
  return p;
}

/** Plain-language read of a probability, for the attack panel. */
export function oddsLabel(p: number): string {
  if (p >= 0.9) return 'Near certain';
  if (p >= 0.7) return 'Strong odds';
  if (p >= 0.5) return 'Favourable';
  if (p >= 0.3) return 'Risky';
  return 'Long shot';
}
