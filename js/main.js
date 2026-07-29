// main.js — boot, master clock, event queue, mode switching.
// A single requestAnimationFrame loop drives all animation; sim time advances
// by wall dt * speed while playing, so pause/speed affect everything coherently.

import { buildScene } from './scenegraph.js';
import { Renderer } from './renderer.js';
import { makeGenerator } from './traffic.js';
import { initUI } from './ui.js';
import { initWalkthrough } from './walkthrough.js';
import { DEFAULT_COUNTS, COUNT_BOUNDS } from './config.js';
import { deriveProfile } from './modelprofile.js';

const LOOKAHEAD = 4;          // seconds of traffic generated ahead of the clock

const state = {
  mode: 'inference',
  t: 0,                       // master sim clock (seconds)
  speed: 1,
  playing: true,
  modeStartT: 0,              // sim time when current mode began
  counts: { ...DEFAULT_COUNTS },
  modelParams: 400e9,
  profile: deriveProfile(400e9),
  gen: null,
  genHorizon: 0,              // sim time up to which events exist
  pending: [],                // events sorted by t0, not yet active
  pendingIdx: 0,
  active: [],
  trafficPaused: false,       // walkthrough scripted-scene mode
  frameMs: 0,
  lastStats: { fabricLoad: 0, pulseCount: 0 },
};

// node counts per pool for the current mode's scene
function countsFor(mode) {
  return mode === 'training'
    ? { nA: state.counts.replicas, nB: state.counts.replicas }
    : { nA: state.counts.prefill, nB: state.counts.decode };
}

let scene = buildScene(countsFor(state.mode));
const renderer = new Renderer(document.getElementById('scene'), scene, state.counts);

function resetTraffic() {
  state.gen = makeGenerator(state.mode, {
    seed: state.mode === 'training' ? 7 : 42,
    counts: countsFor(state.mode),
    profile: state.profile,
  });
  state.genHorizon = state.t;
  state.pending = [];
  state.pendingIdx = 0;
  state.active = [];
}

function rebuildScene() {
  scene = buildScene(countsFor(state.mode));
  api.scene = scene;
  renderer.rebuild(scene, state.mode, state.counts);
  resetTraffic();
}

function setMode(mode) {
  if (mode === state.mode) return;
  renderer.snapshotRhythmAsGhost();
  state.mode = mode;
  state.modeStartT = state.t;
  rebuildScene();
  ui.onModeChanged(mode);
  walkthrough.onModeChanged(mode);
}

function setCounts(patch) {
  const clamp = (v) => Math.max(COUNT_BOUNDS.min, Math.min(COUNT_BOUNDS.max, v | 0));
  for (const key of ['prefill', 'decode', 'replicas']) {
    if (patch[key] != null) state.counts[key] = clamp(patch[key]);
  }
  state.modeStartT = state.t;
  rebuildScene();
  ui.onCountsChanged();
  walkthrough.refresh();
}

function ensureTraffic() {
  if (state.trafficPaused) return;
  if (state.t + LOOKAHEAD > state.genHorizon) {
    const genUntil = state.t + 2 * LOOKAHEAD;
    const evs = state.gen.generate(genUntil - state.modeStartT);
    for (const e of evs) { e.t0 += state.modeStartT; e.t1 += state.modeStartT; }
    if (evs.length) {
      state.pending = state.pending.slice(state.pendingIdx).concat(evs);
      state.pending.sort((a, b) => a.t0 - b.t0);
      state.pendingIdx = 0;
    }
    state.genHorizon = genUntil;
  }
}

function injectEvents(evs) {
  state.pending = state.pending.slice(state.pendingIdx).concat(evs);
  state.pending.sort((a, b) => a.t0 - b.t0);
  state.pendingIdx = 0;
}

function clearTraffic() {
  state.pending = [];
  state.pendingIdx = 0;
  state.active = [];
}

function tick(dt) {
  state.t += dt;
  ensureTraffic();
  // activate pending events whose window has started
  while (state.pendingIdx < state.pending.length && state.pending[state.pendingIdx].t0 <= state.t) {
    state.active.push(state.pending[state.pendingIdx++]);
  }
  if (state.pendingIdx > 2000) {
    state.pending = state.pending.slice(state.pendingIdx);
    state.pendingIdx = 0;
  }
  // retire finished events
  if (state.active.length) {
    state.active = state.active.filter((e) => e.t1 > state.t);
  }
}

let lastWall = performance.now();
function loop(now) {
  const wallDt = Math.min(0.1, (now - lastWall) / 1000);
  lastWall = now;
  const frameStart = performance.now();
  if (state.playing) tick(wallDt * state.speed);
  state.lastStats = renderer.frame(state.t, state.active);
  state.frameMs = state.frameMs * 0.92 + (performance.now() - frameStart) * 0.08;
  if (debugEl) {
    debugEl.textContent =
      `t=${state.t.toFixed(1)}s  frame=${state.frameMs.toFixed(2)}ms\n` +
      `active=${state.active.length}  pulses=${state.lastStats.pulseCount}  fabric=${state.lastStats.fabricLoad.toFixed(1)}`;
  }
  requestAnimationFrame(loop);
}

// advance the sim instantly (used by the screenshot harness): steps the clock
// in small increments so event lifecycles and rhythm sampling stay correct.
function advance(seconds) {
  const step = 0.05;
  for (let s = 0; s < seconds; s += step) {
    tick(step);
    renderer.frame(state.t, state.active);
  }
}

const debugEl = new URLSearchParams(location.search).has('debug')
  ? (document.getElementById('debug-overlay').hidden = false, document.getElementById('debug-overlay'))
  : null;

function setModelParams(p) {
  state.modelParams = p;
  state.profile = deriveProfile(p);
  // regenerate upcoming traffic so its byte annotations use the new profile
  state.modeStartT = state.t;
  resetTraffic();
  walkthrough.refresh();
}

const api = {
  state, scene, renderer,
  setMode, setCounts, countsFor, setModelParams,
  setSpeed: (v) => { state.speed = v; },
  setPlaying: (v) => { state.playing = v; },
  injectEvents, clearTraffic,
  setTrafficPaused: (v) => {
    if (v === state.trafficPaused) return;
    state.trafficPaused = v;
    if (!v) {
      // Resume as a mini restart. The generator's cursor cannot rewind across
      // the paused gap, so without this the scene sits dead for up to
      // 2*LOOKAHEAD seconds after closing a tour while the clock catches up.
      state.modeStartT = state.t;
      resetTraffic();
    }
  },
  advance,
};

const ui = initUI(api);
const walkthrough = await initWalkthrough(api, ui);
api.walkthrough = walkthrough;

renderer.setMode(state.mode);
resetTraffic();
ui.onModeChanged(state.mode);

window.__viz = api;
requestAnimationFrame(loop);
