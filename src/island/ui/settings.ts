// Player preferences that aren't sound (the sound engine keeps its own).

import { useEffect, useState } from 'react';

export type Speed = 1 | 2;

export interface Prefs {
  speed: Speed;
  /** Encik's tips in the command panel. */
  tips: boolean;
}

const KEY = 'island_ops_prefs_v1';
const DEFAULTS: Prefs = { speed: 1, tips: true };

function read(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { speed: p.speed === 2 ? 2 : 1, tips: p.tips !== false };
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const listeners = new Set<() => void>();

export function setPrefs(patch: Partial<Prefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Not persisted; still applies this session.
  }
  listeners.forEach((l) => l());
}

export function usePrefs(): Prefs {
  const [p, setP] = useState(current);
  useEffect(() => {
    const l = () => setP(current);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return p;
}
