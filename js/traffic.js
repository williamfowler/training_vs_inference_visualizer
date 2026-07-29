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

import { PAR } from './config.js';
import { fmtBytes } from './modelprofile.js';

const flow = (t0, t1, linkId, kind, intensity, dir = 1) =>
  ({ t0, t1, linkId, dir, kind, intensity, discrete: false });
const pulse = (t0, dur, linkId, kind, intensity, dir = 1) =>
  ({ t0, t1: t0 + dur, linkId, dir, kind, intensity, discrete: true });
// annotate an event with a byte estimate for tooltips: {bytes, note} and, for
// streaming transfers, {cum, total} (cumulative bytes so far / whole payload)
const ann = (ev, fields) => Object.assign(ev, fields);

// ---------------------------------------------------------------------------
// Inference: Poisson arrivals, prefill burst -> layerwise KV smear -> decode
// trickle, with lifecycle-triggered storage traffic. No global sync, ever.
// ---------------------------------------------------------------------------

// A request occupies "slot" k: prefill instance k%nA, decode instance k%nB,
// KV link ip-k. Slots range over max(nA, nB) so every node sees traffic even
// when the pools are different sizes.
export function requestLifecycle(t, opts) {
  const { cacheHit, flush, promptScale, outputScale, profile: P } = opts;
  const nA = opts.nA ?? 4, nB = opts.nB ?? 4;
  const k = (opts.slot ?? opts.instance ?? 0) % Math.max(nA, nB);
  const a = k % nA, b = k % nB;
  const ev = [];

  // stylized token counts for this request, used only for byte estimates
  const promptTokens = Math.round(256 + 3800 * promptScale);
  const kvTotal = P ? P.kvBytesPerToken * promptTokens : null;

  // ingress: user -> router -> prefill instance
  ev.push(ann(pulse(t, 0.15, 'in-user', 'request', 0.7),
    { bytes: promptTokens * 4, note: `prompt (~${promptTokens} tokens) as text` }));
  ev.push(ann(pulse(t + 0.16, 0.2, `in-r${a}`, 'request', 0.7),
    { bytes: promptTokens * 4, note: `tokenized prompt (~${promptTokens} tokens) + routing metadata` }));

  let tp = t + 0.4;
  let Dp = (0.4 + 0.8 * promptScale);
  if (cacheHit) {
    // prefix-cache hit: fetch KV from storage first, then a shortened prefill
    const prefixTokens = Math.round(promptTokens * 0.55);
    for (let j = 0; j < 3; j++) {
      ev.push(ann(pulse(t + 0.36 + j * 0.12, 0.3, 'st-A', 'kv-storage', 0.55, -1),
        P && { bytes: (P.kvBytesPerToken * prefixTokens) / 3, note: `KV prefix fetch (~${prefixTokens} cached tokens)` }));
    }
    tp = t + 0.85;
    Dp *= 0.45;
  }

  // prefill burst: hot TP shimmer on both stages + pipeline hops
  const tpNote = P && { bytes: P.tpBytesPerTokenLayer, note: 'per token · per layer — TP all-reduce, stays on NVLink' };
  ev.push(ann(flow(tp, tp + Dp, `nv-A${a}r0`, 'tp-allreduce', 0.92), tpNote));
  ev.push(ann(flow(tp + 0.08, tp + Dp, `nv-A${a}r1`, 'tp-allreduce', 0.88), tpNote));
  for (const f of [0.3, 0.55, 0.8]) {
    ev.push(ann(pulse(tp + Dp * f, 0.18, `pp-A${a}`, 'pp-activation', 0.75),
      P && { bytes: P.activationBytesPerToken * promptTokens, note: `activation hand-off (~${promptTokens}-token prompt)` }));
  }

  // layerwise KV smear: starts DURING prefill and tracks its progress
  const ks = tp + 0.12 * Dp, ke = tp + Dp + 0.15;
  const nChunks = Math.max(1, Math.ceil((ke - ks) / 0.09));
  let chunkIdx = 0;
  for (let tk = ks; tk < ke; tk += 0.09) {
    const prog = (tk - ks) / (ke - ks);
    chunkIdx++;
    ev.push(ann(pulse(tk, 0.35, `ip-${k}`, 'kv-transfer', 0.4 + 0.35 * prog),
      P && {
        bytes: kvTotal / nChunks,
        cum: (kvTotal * chunkIdx) / nChunks,
        total: kvTotal,
        note: `KV pages · ~layer ${Math.max(1, Math.round(prog * P.numLayers))}/${P.numLayers}`,
      }));
  }

  // decode: slower, dimmer, steady — memory-bound texture + token trickle
  const td = tp + Dp + 0.25;
  const Dd = 2 + 6 * outputScale;
  const decNote = P && { bytes: P.tpBytesPerTokenLayer, note: 'per token · per layer — decode TP (memory-bound)' };
  ev.push(ann(flow(td, td + Dd, `nv-B${b}r0`, 'tp-allreduce', 0.3), decNote));
  ev.push(ann(flow(td, td + Dd, `nv-B${b}r1`, 'tp-allreduce', 0.3), decNote));
  for (let tk = td + 0.2; tk < td + Dd; tk += 0.3) {
    ev.push(ann(pulse(tk, 0.55, `ret-${b}`, 'token-return', 0.5),
      { note: 'one streamed token — a few bytes, negligible' }));
  }
  for (let tk = td + 0.3; tk < td + Dd; tk += 0.6) {
    ev.push(ann(pulse(tk, 0.16, `pp-B${b}`, 'pp-activation', 0.3),
      P && { bytes: P.activationBytesPerToken, note: 'activation hand-off (1 token)' }));
  }

  // lifecycle-triggered storage flush on some completions
  if (flush) {
    for (let j = 0; j < 4; j++) {
      ev.push(ann(pulse(td + Dd + 0.15 + j * 0.13, 0.35, 'st-B', 'kv-storage', 0.6, 1),
        P && { bytes: kvTotal / 4, note: `KV flush to storage (~${fmtBytes(kvTotal)} total)` }));
    }
  }
  return ev;
}

class InferenceGen {
  constructor(params = {}) {
    this.rng = mulberry32(params.seed ?? 42);
    this.profile = params.profile ?? null;
    this.nA = params.counts?.nA ?? 4;
    this.nB = params.counts?.nB ?? 4;
    this.slots = Math.max(this.nA, this.nB);
    // mean requests/sec scales with cluster size: constant per-instance load
    this.rate = params.rate ?? 0.2 * this.slots;
    this.nextArrival = 0.5 + this.rng() * 0.8;
    this.rr = 0;
  }
  generate(untilT) {
    const out = [];
    while (this.nextArrival < untilT) {
      const t = this.nextArrival;
      const k = this.rr % this.slots;
      this.rr++;
      out.push(...requestLifecycle(t, {
        slot: k, nA: this.nA, nB: this.nB, profile: this.profile,
        cacheHit: this.rng() < 0.25,
        flush: this.rng() < 0.35,
        promptScale: this.rng(),
        outputScale: this.rng(),
      }));
      // truncated exponential: keeps the Poisson feel but avoids long dead air
      this.nextArrival += Math.min(3.5, -Math.log(1 - this.rng()) / this.rate);
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

const MICROBATCH_TOKENS = 4096;   // stylized micro-batch size for byte notes

export function trainingStep(t0, stepIdx, rng, opts = {}) {
  const R = opts.replicas ?? 4;
  const P = opts.profile;
  const ev = [];
  const jitter = () => (rng() - 0.5) * 0.06;   // ±30ms — synchronized, not identical

  const tpNote = P && { bytes: P.tpBytesPerTokenLayer, note: 'per token · per layer — TP all-reduce, stays on NVLink' };
  const fwdNote = P && { bytes: P.activationBytesPerToken * MICROBATCH_TOKENS, note: `micro-batch activations (~${MICROBATCH_TOKENS / 1024}k tokens) → next stage` };
  const bwdNote = P && { bytes: P.activationBytesPerToken * MICROBATCH_TOKENS, note: `activation gradients (~${MICROBATCH_TOKENS / 1024}k tokens) → previous stage` };

  for (let r = 0; r < R; r++) {
    const j = jitter();
    // pipeline for replica r: A rows 0,1 then B rows 0,1
    const rows = [`nv-A${r}r0`, `nv-A${r}r1`, `nv-B${r}r0`, `nv-B${r}r1`];
    const hops = [`pp-A${r}`, `ip-${r}`, `pp-B${r}`];

    // forward wave: stages light left->right, shimmer stays on to end of fwd
    for (let k = 0; k < 4; k++) {
      const s = t0 + j + k * 0.19;
      ev.push(ann(flow(s, t0 + j + FWD_END, rows[k], 'tp-allreduce', 0.95), tpNote));
      if (k < 3) {
        ev.push(ann(pulse(s + 0.13, 0.13, hops[k], 'pp-activation', 0.9), fwdNote));
        ev.push(ann(pulse(s + 0.2, 0.13, hops[k], 'pp-activation', 0.7), fwdNote));
      }
    }
    // backward wave: right->left, a little slower (grad w.r.t. activations)
    for (let k = 0; k < 4; k++) {
      const s = t0 + j + FWD_END + k * 0.29;
      const row = rows[3 - k];
      ev.push(ann(flow(s, t0 + j + BWD_END, row, 'tp-allreduce', 0.85), tpNote));
      if (k < 3) {
        ev.push(ann(pulse(s + 0.18, 0.16, hops[2 - k], 'pp-activation', 0.85, -1), bwdNote));
        ev.push(ann(pulse(s + 0.26, 0.16, hops[2 - k], 'pp-activation', 0.65, -1), bwdNote));
      }
    }
  }

  // gradient all-reduce: EVERY inter-replica link, simultaneous, bidirectional.
  // Deliberately the dominant visual event. With DP=1 there is nothing to
  // reduce across — no gradient exchange happens at all.
  if (R > 1) {
    const gpus = R * PAR.nodesPerReplica * PAR.gpusPerNode;
    const gradNote = P && { bytes: P.gradBytesTotal, note: `gradient all-reduce — global step, all ${gpus} GPUs` };
    const arLinks = [...Array.from({ length: R }, (_, i) => `ip-${i}`), 'dp-A', 'dp-B'];
    for (const l of arLinks) {
      ev.push(ann(flow(t0 + BWD_END, t0 + AR_END, l, 'grad-allreduce', 1.0, 0), gradNote));
      for (let k = 0; k < 4; k++) {
        ev.push(pulse(t0 + BWD_END + 0.05 + k * 0.11, 0.22, l, 'grad-allreduce', 0.9, k % 2 ? -1 : 1));
      }
    }
  }

  // weight update: brief glow on every GPU at once
  for (const p of ['A', 'B']) for (let n = 0; n < R; n++) {
    ev.push({ t0: t0 + AR_END + 0.02, t1: t0 + AR_END + 0.22, linkId: `${p}${n}`, dir: 1, kind: 'weight-update', intensity: 1, discrete: false });
  }

  // periodic checkpoint: pools -> storage
  if (stepIdx % 8 === 7) {
    const ckNote = P && { bytes: P.checkpointBytes / 2, note: 'checkpoint shard — weights + optimizer state' };
    for (const l of ['st-A', 'st-B']) {
      ev.push(ann(flow(t0 + AR_END, t0 + AR_END + 0.6, l, 'checkpoint', 0.55, 1), ckNote));
      for (let k = 0; k < 5; k++) ev.push(pulse(t0 + AR_END + 0.05 + k * 0.12, 0.4, l, 'checkpoint', 0.8, 1));
    }
  }
  return ev;
}

class TrainingGen {
  constructor(params = {}) {
    this.rng = mulberry32(params.seed ?? 7);
    this.profile = params.profile ?? null;
    this.replicas = params.counts?.nA ?? 4;
    this.step = 0;
  }
  generate(untilT) {
    const out = [];
    while (this.step * STEP_PERIOD < untilT) {
      out.push(...trainingStep(this.step * STEP_PERIOD + 0.4, this.step, this.rng, { replicas: this.replicas, profile: this.profile }));
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
