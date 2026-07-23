// traffic.js — stylized (not simulated) traffic event generation.
// A TransferEvent is {t0, t1, linkId, dir, kind, intensity, discrete}:
//   dir: +1 along the link's path, -1 reverse, 0 bidirectional (flows only)
//   discrete: true -> a single pulse travelling t0->t1; false -> a continuous
//   flow texture (animated dashes) active on the link for [t0, t1].
// Timings are hand-tuned for legibility at 1x, not physical accuracy; the goal
// is correct *relative structure* between the two workloads.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flow = (t0, t1, linkId, kind, intensity, dir = 1) =>
  ({ t0, t1, linkId, dir, kind, intensity, discrete: false });
const pulse = (t0, dur, linkId, kind, intensity, dir = 1) =>
  ({ t0, t1: t0 + dur, linkId, dir, kind, intensity, discrete: true });

// ---------------------------------------------------------------------------
// Inference: Poisson arrivals, prefill burst -> layerwise KV smear -> decode
// trickle, with lifecycle-triggered storage traffic. No global sync, ever.
// ---------------------------------------------------------------------------

export function requestLifecycle(t, opts) {
  const { instance: i, cacheHit, flush, promptScale, outputScale } = opts;
  const ev = [];

  // ingress: user -> router -> prefill instance
  ev.push(pulse(t, 0.15, 'in-user', 'request', 0.7));
  ev.push(pulse(t + 0.16, 0.2, `in-r${i}`, 'request', 0.7));

  let tp = t + 0.4;
  let Dp = (0.4 + 0.8 * promptScale);
  if (cacheHit) {
    // prefix-cache hit: fetch KV from storage first, then a shortened prefill
    for (let k = 0; k < 3; k++) ev.push(pulse(t + 0.36 + k * 0.12, 0.3, 'st-A', 'kv-storage', 0.55, -1));
    tp = t + 0.85;
    Dp *= 0.45;
  }

  // prefill burst: hot TP shimmer on both stages + pipeline hops
  ev.push(flow(tp, tp + Dp, `nv-A${i}r0`, 'tp-allreduce', 0.92));
  ev.push(flow(tp + 0.08, tp + Dp, `nv-A${i}r1`, 'tp-allreduce', 0.88));
  for (const f of [0.3, 0.55, 0.8]) ev.push(pulse(tp + Dp * f, 0.18, `pp-A${i}`, 'pp-activation', 0.75));

  // layerwise KV smear: starts DURING prefill and tracks its progress
  const ks = tp + 0.12 * Dp, ke = tp + Dp + 0.15;
  for (let tk = ks; tk < ke; tk += 0.09) {
    const prog = (tk - ks) / (ke - ks);
    ev.push(pulse(tk, 0.35, `ip-${i}`, 'kv-transfer', 0.4 + 0.35 * prog));
  }

  // decode: slower, dimmer, steady — memory-bound texture + token trickle
  const td = tp + Dp + 0.25;
  const Dd = 2 + 6 * outputScale;
  ev.push(flow(td, td + Dd, `nv-B${i}r0`, 'tp-allreduce', 0.3));
  ev.push(flow(td, td + Dd, `nv-B${i}r1`, 'tp-allreduce', 0.3));
  for (let tk = td + 0.2; tk < td + Dd; tk += 0.3) {
    ev.push(pulse(tk, 0.55, `ret-${i}`, 'token-return', 0.5));
  }
  for (let tk = td + 0.3; tk < td + Dd; tk += 0.6) {
    ev.push(pulse(tk, 0.16, `pp-B${i}`, 'pp-activation', 0.3));
  }

  // lifecycle-triggered storage flush on some completions
  if (flush) {
    for (let k = 0; k < 4; k++) ev.push(pulse(td + Dd + 0.15 + k * 0.13, 0.35, 'st-B', 'kv-storage', 0.6, 1));
  }
  return ev;
}

class InferenceGen {
  constructor(params = {}) {
    this.rng = mulberry32(params.seed ?? 42);
    this.rate = params.rate ?? 0.8;           // mean requests/sec
    this.nextArrival = 0.5 + this.rng() * 0.8;
    this.rr = 0;
  }
  generate(untilT) {
    const out = [];
    while (this.nextArrival < untilT) {
      const t = this.nextArrival;
      const i = this.rr % 4;
      this.rr++;
      out.push(...requestLifecycle(t, {
        instance: i,
        cacheHit: this.rng() < 0.25,
        flush: this.rng() < 0.35,
        promptScale: this.rng(),
        outputScale: this.rng(),
      }));
      this.nextArrival += -Math.log(1 - this.rng()) / this.rate;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Training: strict global step loop — forward wave, backward wave, gradient
// all-reduce flash, weight update; checkpoint every ~8 steps. Metronomic.
// ---------------------------------------------------------------------------

export const STEP_PERIOD = 3.0;
const FWD_END = 0.9, BWD_END = 2.2, AR_END = 2.7;

export function trainingStep(t0, stepIdx, rng) {
  const ev = [];
  const jitter = () => (rng() - 0.5) * 0.06;   // ±30ms — synchronized, not identical

  for (let r = 0; r < 4; r++) {
    const j = jitter();
    // pipeline for replica r: A rows 0,1 then B rows 0,1
    const rows = [`nv-A${r}r0`, `nv-A${r}r1`, `nv-B${r}r0`, `nv-B${r}r1`];
    const hops = [`pp-A${r}`, `ip-${r}`, `pp-B${r}`];

    // forward wave: stages light left->right, shimmer stays on to end of fwd
    for (let k = 0; k < 4; k++) {
      const s = t0 + j + k * 0.19;
      ev.push(flow(s, t0 + j + FWD_END, rows[k], 'tp-allreduce', 0.95));
      if (k < 3) {
        ev.push(pulse(s + 0.13, 0.13, hops[k], 'pp-activation', 0.9));
        ev.push(pulse(s + 0.2, 0.13, hops[k], 'pp-activation', 0.7));
      }
    }
    // backward wave: right->left, a little slower (grad w.r.t. activations)
    for (let k = 0; k < 4; k++) {
      const s = t0 + j + FWD_END + k * 0.29;
      const row = rows[3 - k];
      ev.push(flow(s, t0 + j + BWD_END, row, 'tp-allreduce', 0.85));
      if (k < 3) {
        ev.push(pulse(s + 0.18, 0.16, hops[2 - k], 'pp-activation', 0.85, -1));
        ev.push(pulse(s + 0.26, 0.16, hops[2 - k], 'pp-activation', 0.65, -1));
      }
    }
  }

  // gradient all-reduce: EVERY inter-replica link, simultaneous, bidirectional.
  // Deliberately the dominant visual event.
  const arLinks = ['ip-0', 'ip-1', 'ip-2', 'ip-3', 'dp-A', 'dp-B'];
  for (const l of arLinks) {
    ev.push(flow(t0 + BWD_END, t0 + AR_END, l, 'grad-allreduce', 1.0, 0));
    for (let k = 0; k < 4; k++) {
      ev.push(pulse(t0 + BWD_END + 0.05 + k * 0.11, 0.22, l, 'grad-allreduce', 0.9, k % 2 ? -1 : 1));
    }
  }

  // weight update: brief glow on every GPU at once
  for (const p of ['A', 'B']) for (let n = 0; n < 4; n++) {
    ev.push({ t0: t0 + AR_END + 0.02, t1: t0 + AR_END + 0.22, linkId: `${p}${n}`, dir: 1, kind: 'weight-update', intensity: 1, discrete: false });
  }

  // periodic checkpoint: pools -> storage
  if (stepIdx % 8 === 7) {
    for (const l of ['st-A', 'st-B']) {
      ev.push(flow(t0 + AR_END, t0 + AR_END + 0.6, l, 'checkpoint', 0.55, 1));
      for (let k = 0; k < 5; k++) ev.push(pulse(t0 + AR_END + 0.05 + k * 0.12, 0.4, l, 'checkpoint', 0.8, 1));
    }
  }
  return ev;
}

class TrainingGen {
  constructor(params = {}) {
    this.rng = mulberry32(params.seed ?? 7);
    this.step = 0;
  }
  generate(untilT) {
    const out = [];
    while (this.step * STEP_PERIOD < untilT) {
      out.push(...trainingStep(this.step * STEP_PERIOD + 0.4, this.step, this.rng));
      this.step++;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

export function makeGenerator(mode, params) {
  return mode === 'training' ? new TrainingGen(params) : new InferenceGen(params);
}

// Pure batch interface (kept clean so a trace-driven generator could be
// swapped in later): all events whose lifecycle *starts* in [tStart, tEnd).
export function generateEvents(mode, tStart, tEnd, params = {}) {
  const gen = makeGenerator(mode, params);
  gen.generate(tStart);                 // burn state up to the window
  return gen.generate(tEnd).filter((e) => e.t0 >= tStart);
}
