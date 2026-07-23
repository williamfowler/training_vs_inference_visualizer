// ui.js — top-bar controls, tooltips, legend toggle, keyboard shortcuts.

import { MODE_META } from './scenegraph.js';

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
    const meta = MODE_META[api.state.mode];
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

  sceneEl.addEventListener('mousemove', (e) => {
    const tip = e.target instanceof Element ? tipFor(e.target) : null;
    if (!tip) { tooltip.hidden = true; return; }
    tooltip.innerHTML = `<div class="tt-name">${tip.name}</div><div class="tt-role">${tip.role}</div>`;
    tooltip.hidden = false;
    const stage = $('stage').getBoundingClientRect();
    let x = e.clientX - stage.left + 16, y = e.clientY - stage.top + 14;
    if (x + 300 > stage.width) x -= 320;
    if (y + 120 > stage.height) y -= 140;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  });
  sceneEl.addEventListener('mouseleave', () => { tooltip.hidden = true; });

  return {
    setPlaying,
    onModeChanged(mode) {
      btnInf.classList.toggle('active', mode === 'inference');
      btnTrn.classList.toggle('active', mode === 'training');
      btnInf.setAttribute('aria-selected', String(mode === 'inference'));
      btnTrn.setAttribute('aria-selected', String(mode === 'training'));
    },
  };
}
