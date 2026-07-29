// walkthrough.js — guided tour: ordered steps with commentary, highlight
// dimming, and scripted one-off event sequences ("watch a single request").

import { requestLifecycle, trainingStep } from './traffic.js';

// deterministic tiny rng for scripted sequences (jitter only)
function miniRng(seed) { let s = seed; return () => (s = (s * 16807 + 11) % 2147483647) / 2147483647; }

const SCRIPTS = {
  'prefill-loop': (t) => [0, 2.4, 4.8].flatMap((dt) => requestLifecycle(t + 0.4 + dt, {
    instance: 1, cacheHit: false, flush: false, promptScale: 0.8, outputScale: 0,
  })),
  'single-request': (t) => requestLifecycle(t + 0.6, {
    instance: 1, cacheHit: false, flush: true, promptScale: 0.7, outputScale: 0.45,
  }),
  'storage-cycle': (t) => [
    ...requestLifecycle(t + 0.6, { instance: 0, cacheHit: true, flush: false, promptScale: 0.8, outputScale: 0.25 }),
    ...requestLifecycle(t + 3.2, { instance: 2, cacheHit: false, flush: true, promptScale: 0.4, outputScale: 0.3 }),
  ],
  'single-step': (t) => trainingStep(t + 0.6, 7, miniRng(3)),
};

const SCRIPT_SPAN = { 'prefill-loop': 7.6, 'single-request': 12, 'storage-cycle': 14, 'single-step': 4.2 };

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

    _stopScript() {
      if (wt.scriptTimer) { clearInterval(wt.scriptTimer); wt.scriptTimer = null; }
    },

    _apply() {
      const steps = data[api.state.mode];
      const step = steps[wt.idx];
      progress.textContent = `Step ${wt.idx + 1} of ${steps.length}`;
      title.textContent = step.title;
      body.innerHTML = step.bodyHtml;
      btnPrev.disabled = wt.idx === 0;
      btnNext.textContent = wt.idx === steps.length - 1 ? 'Finish ✓' : 'Next →';

      api.renderer.setHighlight(step.highlight || null);
      wt._stopScript();

      if (step.pauseTraffic) {
        api.setTrafficPaused(true);
        api.clearTraffic();
        if (step.script && SCRIPTS[step.script]) {
          const run = () => api.injectEvents(SCRIPTS[step.script](api.state.t));
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
