// ui.js — top-bar controls, tooltips, legend toggle, keyboard shortcuts.

import { modeMeta } from './scenegraph.js';
import { COUNT_BOUNDS, GPU_CATALOG } from './config.js';
import { KIND_COLORS } from './renderer.js';
import { fmtBytes, MEM_BUDGET_FRAC } from './modelprofile.js';

export function initUI(api) {
  const $ = (id) => document.getElementById(id);
  const btnInf = $('btn-mode-inference'), btnTrn = $('btn-mode-training');
  const btnPlay = $('btn-play'), speedEl = $('speed'), speedLabel = $('speed-label');
  const btnLegend = $('btn-legend'), btnTour = $('btn-tour');
  const tooltip = $('tooltip');
  const sceneEl = $('scene');
  let legendVisible = true;

  btnInf.addEventListener('click', () => api.setMode('inference'));
  btnTrn.addEventListener('click', () => api.setMode('training'));

  function setPlaying(v) {
    api.setPlaying(v);
    btnPlay.textContent = v ? '⏸' : '▶';
  }
  btnPlay.addEventListener('click', () => setPlaying(!api.state.playing));

  speedEl.addEventListener('input', () => {
    const v = Math.pow(2, parseFloat(speedEl.value));   // log slider: 0.25x–4x
    api.setSpeed(v);
    speedLabel.textContent = v.toFixed(2).replace(/0$/, '') + '×';
  });

  btnLegend.addEventListener('click', () => {
    legendVisible = !legendVisible;
    api.renderer.setLegendVisible(legendVisible);
  });

  btnTour.addEventListener('click', () => api.walkthrough.toggle());

  // ----------------------------------------------- GPU selector + derived TP
  const gpuSel = $('gpu-version'), tpReadout = $('tp-readout');
  for (const g of GPU_CATALOG) {
    const o = document.createElement('option');
    o.value = g.id;
    o.textContent = `${g.label} · ${g.memLabel}`;
    gpuSel.append(o);
  }
  gpuSel.value = api.state.gpuId;
  gpuSel.addEventListener('change', () => api.setGpu(gpuSel.value));

  function onModelChanged() {
    const gpu = GPU_CATALOG.find((g) => g.id === api.state.gpuId) || GPU_CATALOG[0];
    tpReadout.textContent = `→ TP=${api.PAR.tp}${api.state.fitsTP ? '' : ' ⚠'}`;
    tpReadout.title = api.state.fitsTP
      ? `Derived from GPU memory: each GPU holds a ${fmtBytes(api.state.tpShardBytes)} weight shard, within ${Math.round(MEM_BUDGET_FRAC * 100)}% of the ${gpu.label}'s ${gpu.memLabel} (the rest is headroom for KV cache and activations).`
      : `Model too large for this pod shape: even at TP=${api.PAR.tp}, each GPU would need ${fmtBytes(api.state.tpShardBytes)} of weights — more than a ${gpu.label} (${gpu.memLabel}) can hold.`;
  }
  onModelChanged();

  // ----------------------------------------------- model-size selector
  const modelSel = $('model-size'), modelCustom = $('model-custom'), modelUnit = $('model-custom-unit');
  modelSel.addEventListener('change', () => {
    const custom = modelSel.value === 'custom';
    modelCustom.hidden = modelUnit.hidden = !custom;
    if (custom) modelCustom.focus();
    else api.setModelParams(Number(modelSel.value));
  });
  modelCustom.addEventListener('change', () => {
    const billions = Math.max(0.5, Math.min(20000, Number(modelCustom.value) || 400));
    modelCustom.value = billions;
    api.setModelParams(billions * 1e9);
  });

  // ----------------------------------------------- cluster-size steppers
  const cfgInference = $('cfg-inference'), cfgTraining = $('cfg-training');
  for (const btn of document.querySelectorAll('.cfg-btn')) {
    const [key, delta] = btn.getAttribute('data-count').split(':');
    btn.addEventListener('click', () => {
      api.setCounts({ [key]: api.state.counts[key] + Number(delta) });
    });
  }
  function onCountsChanged() {
    for (const key of ['prefill', 'decode', 'replicas']) {
      const v = api.state.counts[key];
      $(`val-${key}`).textContent = v;
      for (const btn of document.querySelectorAll(`[data-count^="${key}:"]`)) {
        const delta = Number(btn.getAttribute('data-count').split(':')[1]);
        btn.disabled = (delta < 0 && v <= COUNT_BOUNDS.min) || (delta > 0 && v >= COUNT_BOUNDS.max);
      }
    }
  }
  onCountsChanged();

  // "What this animation lies about" — reachable from the header at any time,
  // and from [data-lies] links inside walkthrough copy.
  const liesPanel = $('lies-panel');
  $('btn-lies').addEventListener('click', () => { liesPanel.hidden = false; });
  document.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.matches('[data-lies]')) {
      e.preventDefault();
      liesPanel.hidden = false;
    }
  });
  $('lies-close').addEventListener('click', () => { liesPanel.hidden = true; });
  liesPanel.addEventListener('click', (e) => { if (e.target === liesPanel) liesPanel.hidden = true; });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.matches('input,button')) {
      e.preventDefault();
      setPlaying(!api.state.playing);
    } else if (e.code === 'ArrowRight' && api.walkthrough.isOpen()) {
      api.walkthrough.next();
    } else if (e.code === 'ArrowLeft' && api.walkthrough.isOpen()) {
      api.walkthrough.prev();
    }
  });

  // ----------------------------------------------------------------- tooltips
  function tipFor(el) {
    const meta = modeMeta(api.state.mode, api.state.counts);
    const serverEl = el.closest('[data-server]');
    const rowEl = el.closest('[data-row]');
    if (rowEl) {
      const row = findRow(rowEl.getAttribute('data-row'));
      if (row) return meta.rowTip(row);
    }
    if (serverEl) {
      const s = api.scene.servers.find((x) => x.id === serverEl.getAttribute('data-server'));
      if (s) return meta.serverTip(s);
    }
    const actorEl = el.closest('[data-actor]');
    if (actorEl) {
      const a = actorEl.getAttribute('data-actor');
      if (meta[a] && meta[a].tip) return meta[a].tip;
      if (a === 'rhythm') return { name: 'Rhythm strip', role: 'Total traffic on the datacenter fabric (NVLink excluded), scrolling left. This is the signature an external observer could measure.' };
      if (a === 'legend') return null;
    }
    const linkEl = el.closest('[data-link]');
    if (linkEl) {
      const link = api.renderer.linkById.get(linkEl.getAttribute('data-link'));
      if (link && meta.linkTip[link.cls]) return meta.linkTip[link.cls];
    }
    return null;
  }

  function findRow(id) {
    for (const s of api.scene.servers) for (const r of s.rows) if (r.id === id) return r;
    return null;
  }

  // live per-link traffic estimate: what is on this link *right now*
  function liveTrafficHtml(link) {
    const t = api.state.t;
    const evs = api.state.active.filter((e) => e.linkId === link.id && e.t0 <= t && e.t1 > t);
    if (!evs.length) return '<div class="tt-live tt-idle">idle right now</div>';
    // one line per kind; prefer the event with the largest (cumulative) payload
    const best = new Map();
    const score = (e) => e.cum ?? e.bytes ?? 0;
    for (const e of evs) {
      const cur = best.get(e.kind);
      if (!cur || score(e) > score(cur)) best.set(e.kind, e);
    }
    let html = '';
    for (const [kind, e] of best) {
      let line;
      if (e.cum != null) {
        line = `≈${fmtBytes(e.cum)} of ${fmtBytes(e.total)} streamed — ${e.note}`;
      } else if (e.bytes != null) {
        line = `≈${fmtBytes(e.bytes)} — ${e.note || kind}`;
        if (!e.discrete && e.bytes >= 1e6) {
          line += ` <span class="tt-rate">(~${fmtBytes(e.bytes / (e.t1 - e.t0))}/s at this stylized pace)</span>`;
        }
      } else if (e.note) {
        line = e.note;
      } else {
        continue;
      }
      const dot = `<span class="tt-dot" style="background:${KIND_COLORS[kind] || '#8593ad'}"></span>`;
      html += `<div class="tt-live">${dot}${line}</div>`;
    }
    return html || '<div class="tt-live tt-idle">idle right now</div>';
  }

  let hover = null;   // {el, x, y} — kept so the tooltip can live-refresh
  function renderTooltip() {
    const tip = hover && hover.el.isConnected ? tipFor(hover.el) : null;
    if (!tip) { tooltip.hidden = true; return; }
    let html = `<div class="tt-name">${tip.name}</div><div class="tt-role">${tip.role}</div>`;
    const linkEl = hover.el.closest('[data-link]');
    if (linkEl) {
      const link = api.renderer.linkById.get(linkEl.getAttribute('data-link'));
      if (link) html += liveTrafficHtml(link);
    }
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const stage = $('stage').getBoundingClientRect();
    let x = hover.x - stage.left + 16, y = hover.y - stage.top + 14;
    if (x + 300 > stage.width) x -= 320;
    if (y + 150 > stage.height) y -= 170;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }
  sceneEl.addEventListener('mousemove', (e) => {
    hover = e.target instanceof Element ? { el: e.target, x: e.clientX, y: e.clientY } : null;
    renderTooltip();
  });
  sceneEl.addEventListener('mouseleave', () => { hover = null; tooltip.hidden = true; });
  // refresh while hovering so streaming estimates (e.g. KV) visibly grow
  setInterval(() => { if (hover && !tooltip.hidden) renderTooltip(); }, 300);

  return {
    setPlaying,
    onCountsChanged,
    onModelChanged,
    onModeChanged(mode) {
      btnInf.classList.toggle('active', mode === 'inference');
      btnTrn.classList.toggle('active', mode === 'training');
      btnInf.setAttribute('aria-selected', String(mode === 'inference'));
      btnTrn.setAttribute('aria-selected', String(mode === 'training'));
      cfgInference.hidden = mode !== 'inference';
      cfgTraining.hidden = mode !== 'training';
    },
  };
}
