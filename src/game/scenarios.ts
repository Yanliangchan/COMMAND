// ============================================================================
// COMMAND — Curated scenario pool (phase 11 §1).
//
// A match no longer generates its 72x72 battlefield from an arbitrary seed.
// Instead it draws from a FIXED pool of ten seeds, each hand-picked by
// generating a wide spread of candidates with mapgen.ts's existing generator
// and scoring them programmatically (see the scratchpad evaluation script
// referenced below) against:
//   - passes mapcheck's full validateMap() (water/road/river connectivity,
//     land reachability, no speckle) — non-negotiable, never relaxed here;
//   - a healthy COUNT of objectives (all ten scored 20, the generator's
//     practical ceiling for a 72x72 board);
//   - a wide POSITIONAL SPREAD of those objectives (not clumped in one
//     corner — see the spreadX/spreadY score term);
//   - a high average contested-VP premium (phase 5's contestScore axis —
//     more of the map's value sits on ground both sides have to fight for,
//     not in an uncontested rear area);
//   - PERFECT side balance by construction (mapgen mirrors the two
//     deployment areas in the leading diagonal — see mapgen.ts "CONTEST
//     GEOMETRY" — so every candidate already scores 0 imbalance; this was a
//     sanity check on the scoring, not a discriminator between candidates).
//
// The ten winners were the highest-scoring candidates out of 220 generated
// (seeds 5,000,000 + i*104729 for i in 0..219, decorrelated the same way
// generateBattlefield's own retry loop decorrelates attempts). Every one of
// them independently re-passes validateMap() and the naval-reachability /
// deployment-seat checks scripts/mapcheck.ts runs (see "10 curated maps" in
// that script's own soak test, which iterates this exact pool).
//
// NAMING — real Singapore places and history, per this project's established
// naming convention (see mapgen.ts SETTLEMENT_NAMES and the exercise's own
// "Sabre"/"Vanguard" framing). Sources (WebSearch, phase 11):
//   - "8 Historically Significant Places to Visit in Singapore" (Accor) and
//     "Reflections at Bukit Chandu" (heritage.sg / Wikipedia) — the Battle of
//     Pasir Panjang and Bukit Chandu ("Opium Hill").
//   - "Battle of Bukit Timah" (roots.gov.sg / Wikipedia / NLB) and "Battle of
//     Kranji" (Wikipedia) — Bukit Timah Hill (the island's highest point and
//     1942's key transport corridor and supply-depot ground), the Kranji
//     River crossing, and the Kranji-Jurong defence line.
//   - "From Villages to Flats (Part 1) — The Kampong Days" (Remember
//     Singapore) and "Bukit Timah had kampongs up until the 1980s"
//     (Mothership.SG) — the historic kampong names Ama Keng, Chong Pang, Choa
//     Chu Kang, Kampong Bahru, Paya Lebar and Toa Payoh, all cleared
//     villages/districts from Singapore's pre-HDB landscape.
//
// IMPORTANT: this is a THEMED, FICTIONAL scenario name over a procedurally
// generated 72x72 battlefield — it is explicitly NOT presented, and must
// never be presented, as an accurate depiction of the real place. No two
// curated maps here are coastal/naval-heavy; every one keeps naval assets
// secondary (2-3 maritime anchorages out of 20 objectives), consistent with
// this being primarily an army-focused exercise — see project direction.
// ============================================================================

export interface Scenario {
  id: string;
  /** Displayed on the briefing screen and the map/scenario picker. */
  name: string;
  /** One-line "what this ground is like" blurb — shown alongside the name. */
  blurb: string;
  /** Fixed generator seed — the same ten maps are stable across deploys. */
  seed: number;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'sarimbun',
    name: 'Sarimbun Crossing',
    blurb: 'A river-cut approach from the north-west, the historic line of first contact — close terrain and a handful of hard-fought bridges.',
    seed: 11388469,
  },
  {
    id: 'kranji',
    name: 'Kranji Approaches',
    blurb: 'Rolling ground astride a major river line — armour-country flats broken by high ground overlooking every crossing.',
    seed: 24165407,
  },
  {
    id: 'jurong-line',
    name: 'The Jurong Line',
    blurb: 'A defence-in-depth ridge between two river valleys — whoever holds the spine of it dictates the whole battle.',
    seed: 22594472,
  },
  {
    id: 'bukit-timah',
    name: 'Bukit Timah Heights',
    blurb: 'The island’s commanding high ground and its transport corridor — the objective every axis of advance runs through.',
    seed: 17462751,
  },
  {
    id: 'bukit-chandu',
    name: 'Bukit Chandu',
    blurb: 'Opium Hill and its ridgeline approaches — dense close country favouring infantry and a dug-in defence.',
    seed: 21023537,
  },
  {
    id: 'choa-chu-kang',
    name: 'Choa Chu Kang Corridor',
    blurb: 'Open farmland and scattered settlements along a road corridor — room for armour to manoeuvre on both flanks.',
    seed: 23746491,
  },
  {
    id: 'ama-keng',
    name: 'Ama Keng Crossroads',
    blurb: 'A village road-junction contest — several small settlements in reach of each other, none of them decisive alone.',
    seed: 24689052,
  },
  {
    id: 'chong-pang',
    name: 'Chong Pang Village',
    blurb: 'Mixed forest and open ground around a market village — good cover for an advance, few easy lines of sight.',
    seed: 8874973,
  },
  {
    id: 'paya-lebar',
    name: 'Paya Lebar Flats',
    blurb: 'Wide low ground with an airfield in play — control of the strip matters as much as the villages either side of it.',
    seed: 7618225,
  },
  {
    id: 'toa-payoh',
    name: 'Toa Payoh Basin',
    blurb: 'A river basin ringed by hills — the high ground overlooks every settlement in the valley below it.',
    seed: 17881667,
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Uniform pick from the curated pool — used whenever a match does not name a scenario. */
export function randomScenario(): Scenario {
  return SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
}
