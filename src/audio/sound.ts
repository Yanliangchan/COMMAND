// ============================================================================
// COMMAND — Procedurally-synthesized sound design (phase 10 §5).
//
// Everything here is generated at play time with the Web Audio API — no
// external audio files are loaded, sourced or embedded, so there is nothing
// to license or host. Each sound is a short, restrained tone/noise burst
// built from oscillators and filtered noise, in keeping with a "modern
// tactical ops-room" identity rather than a game-show one.
//
// FOG-OF-WAR: this module knows nothing about game state, contacts or
// detection rungs — it only plays a named sound when told to. Every call
// site in App.tsx/renderMap.ts is responsible for only calling `play()` for
// information the viewing player has legitimately been sent (see the call
// sites: move/attack are the viewer's own actions; contact/kill read off the
// already fog-filtered `state.players[you].contacts` / `state.killFeed`;
// objective ownership and turn changes are never fog-gated in the first
// place — see fog.ts, which never redacts `objectives`).
//
// AUTOPLAY POLICY: browsers refuse to start an AudioContext until a genuine
// user gesture has reached the page. `unlock()` is called from the first
// pointerdown/keydown the app sees (see App.tsx) and creates+resumes the
// context inside that gesture's call stack, which satisfies the policy for
// every later, possibly-async call (an opponent's move arriving over the
// wire, for instance). Every entry point is wrapped in try/catch: a blocked
// or unsupported AudioContext must never throw into game logic, and must
// never spam the console — it just stays silent.
// ============================================================================

export type SoundName = 'move' | 'attack' | 'contact' | 'objective' | 'turn' | 'kill' | 'ui';

interface AudioSettings {
  muted: boolean;
  volume: number; // 0..1
}

const STORAGE_KEY = 'command_audio_v1';
const DEFAULT_SETTINGS: AudioSettings = { muted: false, volume: 0.35 };

function loadSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : DEFAULT_SETTINGS.muted,
      volume: typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1 ? parsed.volume : DEFAULT_SETTINGS.volume,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: AudioSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorage unavailable (private browsing, quota) — the mute toggle
    // still works for the rest of this session, it just won't persist.
  }
}

type Listener = (s: AudioSettings) => void;

class SoundEngine {
  private settings: AudioSettings = loadSettings();
  private ctx: AudioContext | null = null;
  private listeners = new Set<Listener>();
  private noiseBufferCache: AudioBuffer | null = null;
  private ambienceBufferCache: AudioBuffer | null = null;
  // Part 2 §4 — a quiet, CONTINUOUS ambience bed, distinct from the 7 short
  // one-shot cues above: a looping low-pass-filtered noise floor with a very
  // slow LFO drifting its cutoff, meant to sit almost below the threshold of
  // conscious notice. Exactly one instance ever runs; start/stop are
  // idempotent so callers never have to track whether it's already going.
  private ambience: { src: AudioBufferSourceNode; gain: GainNode; lfo: OscillatorNode } | null = null;
  private ambienceWanted = false;

  getSettings(): AudioSettings {
    return this.settings;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((fn) => fn(this.settings));
  }

  setMuted(muted: boolean) {
    this.settings = { ...this.settings, muted };
    saveSettings(this.settings);
    this.notify();
    this.syncAmbienceVolume();
  }

  setVolume(volume: number) {
    this.settings = { ...this.settings, volume: Math.max(0, Math.min(1, volume)) };
    saveSettings(this.settings);
    this.notify();
    this.syncAmbienceVolume();
  }

  /** Create (or resume) the AudioContext. Call ONLY from inside a real user-gesture handler. */
  unlock() {
    this.ensureContext();
    // A match may already be under way (e.g. reconnect) by the time the
    // first real gesture reaches the page — pick the ambience bed back up
    // the instant the context is actually allowed to make sound.
    if (this.ambienceWanted) this.startAmbience();
  }

  private brownNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.ambienceBufferCache && this.ambienceBufferCache.sampleRate === ctx.sampleRate) return this.ambienceBufferCache;
    // A few seconds of looping brown-ish noise (integrated white noise, DC-
    // corrected) — a soft, low rumble rather than white noise's harsh hiss,
    // the right texture for "quiet ambience bed" rather than another cue.
    const len = Math.floor(ctx.sampleRate * 6);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2; // renormalize — the running integral drifts quiet
    }
    this.ambienceBufferCache = buf;
    return buf;
  }

  /**
   * Start the continuous ambience bed if it isn't already running. Idempotent
   * and safe to call any number of times (e.g. every render) — a no-op if
   * already running, muted, silenced, or the AudioContext isn't unlocked yet
   * (in which case `unlock()` picks it back up on the next real gesture).
   */
  startAmbience() {
    this.ambienceWanted = true;
    if (this.ambience) return;
    const ctx = this.ensureContext();
    if (!ctx || ctx.state !== 'running') return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = this.brownNoiseBuffer(ctx);
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(340, ctx.currentTime);
      filter.Q.setValueAtTime(0.4, ctx.currentTime);
      // A very slow LFO on the cutoff — the only thing that keeps this from
      // reading as a static hiss. ~50-second period: deliberately far too
      // slow to consciously track, just enough that it never sits static.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(1 / 50, ctx.currentTime);
      const lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(90, ctx.currentTime);
      lfo.connect(lfoGain).connect(filter.frequency);
      lfo.start();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start();
      this.ambience = { src, gain, lfo };
      this.syncAmbienceVolume(1.4); // fade in
    } catch {
      // Ambience is pure atmosphere — never let synthesis trouble surface.
    }
  }

  /** Stop the ambience bed (fade out, then release the nodes). Idempotent. */
  stopAmbience() {
    this.ambienceWanted = false;
    const amb = this.ambience;
    if (!amb || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      amb.gain.gain.cancelScheduledValues(t);
      amb.gain.gain.setValueAtTime(amb.gain.gain.value, t);
      amb.gain.gain.linearRampToValueAtTime(0, t + 1.2);
      amb.src.stop(t + 1.3);
      amb.lfo.stop(t + 1.3);
    } catch {
      // ignore — worst case the nodes free themselves once GC'd
    }
    this.ambience = null;
  }

  /** Re-target the ambience gain to the current mute/volume settings. */
  private syncAmbienceVolume(rampSeconds = 0.6) {
    const amb = this.ambience;
    if (!amb || !this.ctx) return;
    // Kept deliberately far quieter than any one-shot cue — "barely
    // perceptible", per the brief, not a mix element competing with them.
    const target = this.settings.muted ? 0 : 0.05 * this.settings.volume;
    try {
      const t = this.ctx.currentTime;
      amb.gain.gain.cancelScheduledValues(t);
      amb.gain.gain.setValueAtTime(amb.gain.gain.value, t);
      amb.gain.gain.linearRampToValueAtTime(target, t + rampSeconds);
    } catch {
      // ignore
    }
  }

  private ensureContext(): AudioContext | null {
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext | undefined =
          (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return null;
        this.ctx = new Ctor();
      }
      if (this.ctx.state === 'suspended') {
        // Fire-and-forget: this only actually resumes when called within a
        // user-gesture call stack. Off a gesture it silently stays suspended
        // (no console noise) and the sound below just won't be audible.
        void this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    } catch {
      return null;
    }
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBufferCache && this.noiseBufferCache.sampleRate === ctx.sampleRate) return this.noiseBufferCache;
    const len = Math.floor(ctx.sampleRate * 0.6);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBufferCache = buf;
    return buf;
  }

  /** Play one of the small named tactical-UI sounds. Never throws. */
  play(name: SoundName) {
    if (this.settings.muted || this.settings.volume <= 0) return;
    const ctx = this.ensureContext();
    if (!ctx || ctx.state !== 'running') return;
    try {
      const t0 = ctx.currentTime;
      const vol = this.settings.volume;
      switch (name) {
        case 'move':
          this.tone(ctx, t0, { freq: 320, freqTo: 210, dur: 0.07, type: 'triangle', gain: 0.22 * vol });
          break;
        case 'ui':
          this.tone(ctx, t0, { freq: 980, dur: 0.035, type: 'sine', gain: 0.12 * vol });
          break;
        case 'turn':
          this.tone(ctx, t0, { freq: 130, freqTo: 95, dur: 0.32, type: 'triangle', gain: 0.3 * vol, attack: 0.01 });
          break;
        case 'objective':
          this.tone(ctx, t0, { freq: 440, freqTo: 880, dur: 0.42, type: 'sine', gain: 0.24 * vol, attack: 0.02 });
          this.tone(ctx, t0 + 0.05, { freq: 660, freqTo: 1100, dur: 0.32, type: 'sine', gain: 0.14 * vol, attack: 0.02 });
          break;
        case 'contact': {
          this.tone(ctx, t0, { freq: 660, dur: 0.14, type: 'triangle', gain: 0.2 * vol, attack: 0.005 });
          this.tone(ctx, t0 + 0.13, { freq: 880, dur: 0.22, type: 'triangle', gain: 0.22 * vol, attack: 0.005 });
          break;
        }
        case 'attack':
          this.noiseBurst(ctx, t0, { dur: 0.16, gain: 0.32 * vol, filterFreq: 1400, filterQ: 0.7 });
          this.tone(ctx, t0, { freq: 180, freqTo: 70, dur: 0.14, type: 'sawtooth', gain: 0.2 * vol, attack: 0.002 });
          break;
        case 'kill':
          this.noiseBurst(ctx, t0, { dur: 0.5, gain: 0.34 * vol, filterFreq: 700, filterQ: 0.5 });
          this.tone(ctx, t0, { freq: 90, freqTo: 42, dur: 0.5, type: 'sine', gain: 0.3 * vol, attack: 0.003 });
          break;
      }
    } catch {
      // Synthesis failure of any kind is cosmetic — never let it interrupt play.
    }
  }

  private tone(
    ctx: AudioContext,
    at: number,
    opts: { freq: number; freqTo?: number; dur: number; type: OscillatorType; gain: number; attack?: number }
  ) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = opts.type;
    osc.frequency.setValueAtTime(opts.freq, at);
    if (opts.freqTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqTo), at + opts.dur);
    }
    const attack = opts.attack ?? 0.008;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(opts.gain, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, at + opts.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + opts.dur + 0.02);
  }

  private noiseBurst(ctx: AudioContext, at: number, opts: { dur: number; gain: number; filterFreq: number; filterQ: number }) {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(opts.filterFreq, at);
    filter.Q.setValueAtTime(opts.filterQ, at);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(opts.gain, at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.001, at + opts.dur);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(at);
    src.stop(at + opts.dur + 0.02);
  }
}

/** One shared engine for the whole app — sounds are cheap, stateless calls into it. */
export const sound = new SoundEngine();
