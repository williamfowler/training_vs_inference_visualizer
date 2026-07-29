// walkthrough.js — guided tour: ordered steps with commentary, highlight
// dimming, and scripted one-off event sequences ("watch a single request").

import { requestLifecycle, trainingStep } from './traffic.js';
import { PAR } from './config.js';

// deterministic tiny rng for scripted sequences (jitter only)
function miniRng(seed) { let s = seed; return () => (s = (s * 16807 + 11) % 2147483647) / 2147483647; }

// Scripts receive ctx = {nA, nB, slot} so scripted requests land on instances
// that actually exist at the current cluster size.
const SCRIPTS = {
  'prefill-loop': (t, c) => [0, 2.4, 4.8].flatMap((dt) => requestLifecycle(t + 0.4 + dt, {
    slot: c.slot(1), nA: c.nA, nB: c.nB, cacheHit: false, flush: false, promptScale: 0.8, outputScale: 0,
  })),
  'single-request': (t, c) => requestLifecycle(t + 0.6, {
    slot: c.slot(1), nA: c.nA, nB: c.nB, cacheHit: false, flush: true, promptScale: 0.7, outputScale: 0.45,
  }),
  'storage-cycle': (t, c) => [
    ...requestLifecycle(t + 0.6, { slot: c.slot(0), nA: c.nA, nB: c.nB, cacheHit: true, flush: false, promptScale: 0.8, outputScale: 0.25 }),
    ...requestLifecycle(t + 3.2, { slot: c.slot(2), nA: c.nA, nB: c.nB, cacheHit: false, flush: true, promptScale: 0.4, outputScale: 0.3 }),
  ],
  'single-step': (t, c) => trainingStep(t + 0.6, 7, miniRng(3), { replicas: c.nA }),
};

const SCRIPT_SPAN = { 'prefill-loop': 7.6, 'single-request': 12, 'storage-cycle': 14, 'single-step': 4.2 };

// ---------------------------------------------------------------------------
// Cluster-size adaptation: step JSON is written against the default 4/4/4
// cluster; ids are remapped through the same slot arithmetic traffic.js uses,
// and "*" / "ip-*" wildcards expand to whatever exists right now.
// ---------------------------------------------------------------------------

function adaptId(id, nA, nB) {
  const m = id.match(/^(nv-A|nv-B|pp-A|pp-B|in-r|ret-|ip-|A|B)(\d+)(.*)$/);
  if (!m) return id;
  const s = Math.min(Number(m[2]), Math.max(nA, nB) - 1);
  const idx = {
    'nv-A': s % nA, 'pp-A': s % nA, 'A': s % nA, 'in-r': s % nA,
    'nv-B': s % nB, 'pp-B': s % nB, 'B': s % nB, 'ret-': s % nB,
    'ip-': s,
  }[m[1]];
  return m[1] + idx + m[3];
}

function adaptHighlight(spec, api) {
  if (!spec) return null;
  const { nA, nB } = api.countsFor(api.state.mode);
  const expand = (list, all) => [...new Set(list.flatMap((id) => {
    if (id === '*') return api.scene.servers.map((s) => s.id);
    if (id.endsWith('-*')) {
      const prefix = id.slice(0, -1);
      return api.scene.links.filter((l) => l.id.startsWith(prefix)).map((l) => l.id);
    }
    return [adaptId(id, nA, nB)];
  }))];
  const out = { ...spec };
  if (out.servers) out.servers = expand(out.servers);
  if (out.links) out.links = expand(out.links);
  return out;
}

// {token} substitution in step copy, so node/GPU counts track the live config
function fillTemplates(html, api) {
  const c = api.state.counts;
  const R = c.replicas;
  const nodes = api.state.mode === 'training' ? R * PAR.nodesPerReplica : c.prefill + c.decode;
  const subs = {
    nodesTotal: nodes,
    gpusTotal: nodes * PAR.gpusPerNode,
    replicas: R,
    replicaSpread: R > 1
      ? `Replica 0 is the top pair of nodes; replica ${R - 1} the bottom pair.`
      : 'The single replica spans the one pair of nodes.',
  };
  return html.replace(/\{(\w+)\}/g, (whole, key) => (key in subs ? String(subs[key]) : whole));
}

export async function initWalkthrough(api, ui) {
  const $ = (id) => document.getElementById(id);
  const panel = $('tour-panel'), title = $('tour-title'), body = $('tour-body');
  const progress = $('tour-progress'), btnPrev = $('tour-prev'), btnNext = $('tour-next');

  const data = {};
  for (const mode of ['inference', 'training']) {
    const res = await fetch(`data/walkthrough-${mode}.json`);
    data[mode] = (await res.json()).steps;
  }

  const wt = {
    open: false,
    idx: 0,
    scriptTimer: null,

    isOpen: () => wt.open,

    toggle() { wt.open ? wt.close() : wt.show(0); },

    show(idx) {
      wt.open = true;
      wt.idx = idx;
      panel.hidden = false;
      wt._apply();
    },

    close() {
      wt.open = false;
      panel.hidden = true;
      wt._stopScript();
      api.renderer.setHighlight(null);
      api.setTrafficPaused(false);
    },

    next() {
      const steps = data[api.state.mode];
      if (wt.idx < steps.length - 1) wt.show(wt.idx + 1);
      else wt.close();
    },
    prev() { if (wt.idx > 0) wt.show(wt.idx - 1); },

    onModeChanged() {
      wt._stopScript();
      if (wt.open) wt.show(0);
    },

    // re-apply the current step (used when cluster counts change mid-tour)
    refresh() { if (wt.open) wt._apply(); },

    _stopScript() {
      if (wt.scriptTimer) { clearInterval(wt.scriptTimer); wt.scriptTimer = null; }
    },

    _apply() {
      const steps = data[api.state.mode];
      const step = steps[wt.idx];
      progress.textContent = `Step ${wt.idx + 1} of ${steps.length}`;
      title.textContent = step.title;
      body.innerHTML = fillTemplates(step.bodyHtml, api);
      btnPrev.disabled = wt.idx === 0;
      btnNext.textContent = wt.idx === steps.length - 1 ? 'Finish ✓' : 'Next →';

      api.renderer.setHighlight(adaptHighlight(step.highlight, api));
      wt._stopScript();

      if (step.pauseTraffic) {
        api.setTrafficPaused(true);
        api.clearTraffic();
        if (step.script && SCRIPTS[step.script]) {
          const ctx = () => {
            const { nA, nB } = api.countsFor(api.state.mode);
            return { nA, nB, slot: (i) => Math.min(i, Math.max(nA, nB) - 1) };
          };
          const run = () => api.injectEvents(SCRIPTS[step.script](api.state.t, ctx()));
          run();
          // loop the scripted sequence while the user lingers on this step
          const spanMs = (SCRIPT_SPAN[step.script] || 10) * 1000;
          wt.scriptTimer = setInterval(() => {
            if (api.state.playing) run();
          }, spanMs / Math.max(0.25, api.state.speed));
        }
      } else {
        api.setTrafficPaused(false);
      }
    },
  };

  btnPrev.addEventListener('click', () => wt.prev());
  btnNext.addEventListener('click', () => wt.next());
  $('tour-close').addEventListener('click', () => wt.close());

  return wt;
}
