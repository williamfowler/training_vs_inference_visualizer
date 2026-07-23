// renderer.js — draws the static scene into SVG and animates traffic on top
// of it. All continuous animation is driven from a single master clock value
// passed into frame(); no D3 transitions are used for traffic.

import { VIEW, POOL, NODE, RHYTHM, LEGEND, STORAGE, ROUTER, USER, nodeY } from './layout.js';
import { MODE_META } from './scenegraph.js';

export const KIND_COLORS = {
  'request':        '#7d9bff',
  'tp-allreduce':   '#22d3ee',
  'pp-activation':  '#f2f6fc',
  'kv-transfer':    '#fbbf24',
  'kv-storage':     '#a78bfa',
  'token-return':   '#4ade80',
  'grad-allreduce': '#ff5d3a',
  'weight-update':  '#ffd166',
  'checkpoint':     '#a78bfa',
};

const KIND_CORE = {};   // brighter core color per kind, precomputed
for (const [k, c] of Object.entries(KIND_COLORS)) {
  KIND_CORE[k] = d3.color(c).brighter(0.9).formatHex();
}

const LEGEND_ITEMS = {
  inference: [
    ['request',        'Request ingress'],
    ['tp-allreduce',   'TP all-reduce shimmer (NVLink)'],
    ['pp-activation',  'Pipeline activation hop'],
    ['kv-transfer',    'KV-cache transfer (prefill → decode)'],
    ['kv-storage',     'KV fetch / flush (storage tier)'],
    ['token-return',   'Token trickle (decode → user)'],
  ],
  training: [
    ['tp-allreduce',   'TP all-reduce shimmer (NVLink)'],
    ['pp-activation',  'Activations fwd / gradients bwd'],
    ['grad-allreduce', 'Gradient all-reduce (global, every step)'],
    ['weight-update',  'Weight update (all GPUs at once)'],
    ['checkpoint',     'Checkpoint write (every ~8 steps)'],
  ],
};

const GPU_BASE_FILL = '#1b2540';
const RHYTHM_VMAX = 22;         // fixed vertical scale so modes are comparable
const RHYTHM_WINDOW = 30;       // seconds of history shown
const RHYTHM_DT = 0.1;          // sample spacing (sim seconds)

export class Renderer {
  constructor(svgEl, scene) {
    this.svg = d3.select(svgEl);
    this.scene = scene;
    this.mode = 'inference';
    this.highlightSpec = null;

    this.linkById = new Map();
    this.flowEls = new Map();     // `${linkId}|${dir}` -> path element
    this.pulsePool = [];
    this.pulseByEvent = new Map();
    this.rowFillCache = new Map();
    this.serverEls = new Map();
    this.rowEls = new Map();
    this.actorEls = {};

    this.rhythm = { samples: [], ghost: null, ghostMode: null, acc: 0, accN: 0, lastT: -Infinity };

    this._build();
  }

  // ------------------------------------------------------------- static build
  _build() {
    const svg = this.svg;
    svg.selectAll('*').remove();
    // z-order: server boxes UNDER links so intra-node links stay visible;
    // GPUs above links; pulses on top of everything.
    this.gBoxes = svg.append('g').attr('id', 'g-boxes');
    this.gLinks = svg.append('g').attr('id', 'g-links');
    this.gFlows = svg.append('g').attr('id', 'g-flows');
    this.gNodes = svg.append('g').attr('id', 'g-nodes');
    this.gPulses = svg.append('g').attr('id', 'g-pulses');
    this.gLabels = svg.append('g').attr('id', 'g-labels');
    this.gLegend = svg.append('g').attr('id', 'g-legend');
    this.gRhythm = svg.append('g').attr('id', 'g-rhythm');

    // --- links (base strokes) + path sampling for pointAt ---
    for (const link of this.scene.links) {
      const el = this.gLinks.append('path')
        .attr('class', `link-base dimmable ${link.cls}`)
        .attr('d', link.d)
        .attr('data-link', link.id)
        .node();
      link.el = el;
      const len = el.getTotalLength();
      const N = 40;
      const pts = new Float32Array((N + 1) * 2);
      for (let i = 0; i <= N; i++) {
        const p = el.getPointAtLength((len * i) / N);
        pts[i * 2] = p.x; pts[i * 2 + 1] = p.y;
      }
      link.len = len;
      link.pointAt = (u) => {
        const f = Math.max(0, Math.min(1, u)) * N;
        const i = Math.min(N - 1, Math.floor(f)), fr = f - i;
        return [pts[i * 2] * (1 - fr) + pts[(i + 1) * 2] * fr,
                pts[i * 2 + 1] * (1 - fr) + pts[(i + 1) * 2 + 1] * fr];
      };
      this.linkById.set(link.id, link);
    }
    // DP rail stubs (decorative short connectors from rail to node edges)
    for (const [railId, x, poolX] of [['dp-A', 344, POOL.A.x], ['dp-B', 1296, POOL.B.x + POOL.w]]) {
      for (let i = 0; i < NODE.perPool; i++) {
        this.gLinks.append('line')
          .attr('class', 'link-base dimmable')
          .attr('data-link', railId)
          .attr('x1', x).attr('x2', poolX)
          .attr('y1', nodeY(i) + NODE.h / 2).attr('y2', nodeY(i) + NODE.h / 2);
      }
    }

    // --- servers + GPUs ---
    for (const s of this.scene.servers) {
      const box = this.gBoxes.append('g')
        .attr('class', 'server dimmable')
        .attr('data-server', s.id);
      box.append('rect').attr('class', 'node-box')
        .attr('x', s.x).attr('y', s.y).attr('width', s.w).attr('height', s.h)
        .attr('rx', 6);
      box.append('text').attr('class', 'node-label')
        .attr('x', s.x + 6).attr('y', s.y + s.h - 5)
        .text(s.id);
      const g = this.gNodes.append('g')
        .attr('class', 'server dimmable')
        .attr('data-server', s.id);
      for (const row of s.rows) {
        const rg = g.append('g').attr('data-row', row.id);
        for (const gpu of row.gpus) {
          rg.append('rect').attr('class', 'gpu')
            .attr('data-gpu', gpu.id)
            .attr('x', gpu.x).attr('y', gpu.y)
            .attr('width', gpu.s).attr('height', gpu.s).attr('rx', 4);
        }
        this.rowEls.set(row.id, rg.node());
      }
      this.serverEls.set(s.id, g.node());
    }

    // --- actors ---
    this._buildActors();
    this._buildRhythmFrame();
    this.setMode('inference');
  }

  _buildActors() {
    // user / data-source icon: cloud-ish blob of circles
    const u = this.gNodes.append('g').attr('class', 'actor dimmable').attr('data-actor', 'user');
    u.append('circle').attr('class', 'icon-fill').attr('cx', USER.cx).attr('cy', USER.cy).attr('r', USER.r);
    u.append('circle').attr('class', 'icon-stroke').attr('cx', USER.cx - 11).attr('cy', USER.cy - 6).attr('r', 9);
    u.append('circle').attr('class', 'icon-stroke').attr('cx', USER.cx + 8).attr('cy', USER.cy - 3).attr('r', 12);
    u.append('circle').attr('class', 'icon-stroke').attr('cx', USER.cx - 2).attr('cy', USER.cy + 10).attr('r', 8);
    this.actorEls.user = u.node();

    const r = this.gNodes.append('g').attr('class', 'actor dimmable').attr('data-actor', 'router');
    r.append('rect').attr('class', 'icon-fill')
      .attr('x', ROUTER.x).attr('y', ROUTER.y).attr('width', ROUTER.w).attr('height', ROUTER.h).attr('rx', 8);
    // crossed-lines router glyph
    const rcx = ROUTER.x + ROUTER.w / 2, rcy = ROUTER.y + 26;
    r.append('path').attr('class', 'icon-stroke')
      .attr('d', `M ${rcx - 16} ${rcy - 8} L ${rcx + 16} ${rcy + 8} M ${rcx - 16} ${rcy + 8} L ${rcx + 16} ${rcy - 8}`);
    this.actorEls.router = r.node();

    const st = this.gNodes.append('g').attr('class', 'actor dimmable').attr('data-actor', 'storage');
    const sx = STORAGE.cx - STORAGE.w / 2, sy = STORAGE.y, sw = STORAGE.w, sh = STORAGE.h;
    st.append('path').attr('class', 'icon-fill')
      .attr('d', `M ${sx} ${sy + 12} A ${sw / 2} 12 0 0 1 ${sx + sw} ${sy + 12} L ${sx + sw} ${sy + sh - 12} A ${sw / 2} 12 0 0 1 ${sx} ${sy + sh - 12} Z`);
    st.append('ellipse').attr('class', 'icon-stroke')
      .attr('cx', STORAGE.cx).attr('cy', sy + 12).attr('rx', sw / 2).attr('ry', 12);
    st.append('path').attr('class', 'icon-stroke')
      .attr('d', `M ${sx} ${sy + 32} A ${sw / 2} 12 0 0 0 ${sx + sw} ${sy + 32}`);
    this.actorEls.storage = st.node();
  }

  _buildRhythmFrame() {
    const g = this.gRhythm.attr('data-actor', 'rhythm').attr('class', 'dimmable');
    g.append('rect').attr('class', 'rhythm-frame')
      .attr('x', RHYTHM.x).attr('y', RHYTHM.y).attr('width', RHYTHM.w).attr('height', RHYTHM.h).attr('rx', 8);
    g.append('text').attr('class', 'rhythm-title')
      .attr('x', RHYTHM.x + 14).attr('y', RHYTHM.y + 22)
      .text('Aggregate fabric traffic — what an outside observer sees');
    this.rhythmSub = g.append('text').attr('class', 'rhythm-sub')
      .attr('x', RHYTHM.x + 14).attr('y', RHYTHM.y + 40).node();
    this.rhythmGhostLabel = g.append('text').attr('class', 'rhythm-sub')
      .attr('x', RHYTHM.x + RHYTHM.w - 14).attr('y', RHYTHM.y + 22)
      .attr('text-anchor', 'end').node();
    this.rhythmGhostArea = g.append('path').attr('class', 'rhythm-ghost-area').attr('fill', '#41507022').node();
    this.rhythmGhostLine = g.append('path').attr('class', 'rhythm-ghost-line').attr('stroke', '#66779c').node();
    this.rhythmArea = g.append('path').attr('class', 'rhythm-area').node();
    this.rhythmLine = g.append('path').attr('class', 'rhythm-line').node();
  }

  // --------------------------------------------------------------- mode/labels
  setMode(mode) {
    this.mode = mode;
    const meta = MODE_META[mode];
    const gl = this.gLabels;
    gl.selectAll('*').remove();

    const poolLabel = (pool, info) => {
      const x = POOL[pool].x;
      gl.append('text').attr('class', 'pool-label dimmable')
        .attr('data-pool-label', pool)
        .attr('x', x).attr('y', 52).text(info.title);
      gl.append('text').attr('class', 'pool-sublabel dimmable')
        .attr('data-pool-label', pool)
        .attr('x', x).attr('y', 72).text(info.sub);
    };
    poolLabel('A', meta.poolA);
    poolLabel('B', meta.poolB);

    gl.append('text').attr('class', 'minor-label dimmable').attr('data-actor-label', 'user')
      .attr('x', USER.cx).attr('y', USER.cy + USER.r + 18).attr('text-anchor', 'middle')
      .text(meta.user.label);
    gl.append('text').attr('class', 'minor-label dimmable').attr('data-actor-label', 'router')
      .attr('x', ROUTER.x + ROUTER.w / 2).attr('y', ROUTER.y + ROUTER.h - 14).attr('text-anchor', 'middle')
      .text(meta.router.label);
    gl.append('text').attr('class', 'minor-label dimmable').attr('data-actor-label', 'storage')
      .attr('x', STORAGE.cx + STORAGE.w / 2 + 14).attr('y', STORAGE.y + 48)
      .text(meta.storage.label);
    gl.append('text').attr('class', 'footnote')
      .attr('x', 40).attr('y', 676).text(meta.footnote);

    this._buildLegend(mode);
    d3.select(this.rhythmSub).text(mode === 'inference'
      ? 'Inference: ragged, uncoordinated bursts — no global rhythm to lock onto.'
      : 'Training: a metronomic comb — one spike per global step, impossible to miss.');
    d3.select(this.rhythmLine).attr('stroke', mode === 'inference' ? '#fbbf24' : '#ff5d3a');
    d3.select(this.rhythmArea).attr('fill', mode === 'inference' ? '#fbbf2426' : '#ff5d3a26');
  }

  _buildLegend(mode) {
    const g = this.gLegend;
    g.selectAll('*').remove();
    g.attr('data-actor', 'legend');
    g.append('rect').attr('class', 'rhythm-frame')
      .attr('x', LEGEND.x).attr('y', LEGEND.y).attr('width', LEGEND.w).attr('height', LEGEND.h).attr('rx', 8);
    g.append('text').attr('class', 'legend-title')
      .attr('x', LEGEND.x + 14).attr('y', LEGEND.y + 24).text('TRAFFIC LEGEND');
    const items = LEGEND_ITEMS[mode];
    items.forEach(([kind, label], i) => {
      const y = LEGEND.y + 48 + i * 26;
      const item = g.append('g').attr('class', 'legend-item');
      item.append('circle').attr('cx', LEGEND.x + 22).attr('cy', y - 4).attr('r', 5.5)
        .attr('fill', KIND_COLORS[kind]).attr('opacity', .5);
      item.append('circle').attr('cx', LEGEND.x + 22).attr('cy', y - 4).attr('r', 2.6)
        .attr('fill', KIND_CORE[kind]);
      item.append('text').attr('x', LEGEND.x + 38).attr('y', y).text(label);
    });
  }

  setLegendVisible(v) { this.gLegend.style('display', v ? null : 'none'); }

  // ------------------------------------------------------------------ animate
  // events: array of active events {t0,t1,linkId,dir,kind,intensity,discrete}
  frame(t, events) {
    const flowBest = new Map();      // key linkId|dir -> event
    const rowGlow = new Map();       // rowId -> {kind, intensity}
    const nodeFlash = new Map();     // serverId -> intensity
    let fabricLoad = 0;
    let pulseCount = 0;

    for (const ev of events) {
      if (ev.kind === 'weight-update') {
        nodeFlash.set(ev.linkId, Math.max(nodeFlash.get(ev.linkId) || 0, ev.intensity));
        continue;
      }
      const link = this.linkById.get(ev.linkId);
      if (!link) continue;

      if (link.cls !== 'nvlink' && ev.kind !== 'request') {
        fabricLoad += ev.intensity * (ev.dir === 0 ? 2 : 1);
      }

      if (ev.discrete) {
        pulseCount++;
        this._drawPulse(ev, link, t);
      } else {
        for (const dir of (ev.dir === 0 ? [1, -1] : [ev.dir])) {
          const key = ev.linkId + '|' + dir;
          const cur = flowBest.get(key);
          if (!cur || ev.intensity > cur.intensity) flowBest.set(key, { ...ev, dir });
        }
        if (link.cls === 'nvlink') {
          const rowId = link.from;
          const cur = rowGlow.get(rowId);
          if (!cur || ev.intensity > cur.intensity) rowGlow.set(rowId, ev);
        }
      }
    }

    this._updateFlows(flowBest, t);
    this._updateRowGlow(rowGlow, nodeFlash);
    this._releaseDeadPulses(events);
    this._pushRhythmSample(t, fabricLoad);
    this._renderRhythm(t);
    return { fabricLoad, pulseCount };
  }

  _updateFlows(flowBest, t) {
    // hide overlays with no active flow
    for (const [key, el] of this.flowEls) {
      if (!flowBest.has(key)) el.style.display = 'none';
    }
    for (const [key, ev] of flowBest) {
      let el = this.flowEls.get(key);
      const link = this.linkById.get(ev.linkId);
      if (!el) {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        el.setAttribute('class', 'link-flow dimmable');
        el.setAttribute('d', link.d);
        el.setAttribute('data-link', ev.linkId);
        el.setAttribute('data-flow', '1');
        this.gFlows.node().appendChild(el);
        this.flowEls.set(key, el);
      }
      el.style.display = '';
      const dashSpeed = 30 + 90 * ev.intensity;      // px/sec
      const [, dir] = key.split('|');
      el.setAttribute('stroke', KIND_COLORS[ev.kind]);
      el.setAttribute('stroke-width', link.cls === 'nvlink' ? 4 : 2.6);
      el.setAttribute('stroke-dasharray', '7 11');
      el.setAttribute('stroke-dashoffset', String((dir === '1' ? -1 : 1) * ((t * dashSpeed) % 18)));
      el.setAttribute('opacity', String(0.25 + 0.65 * ev.intensity));
      el.setAttribute('data-kind', ev.kind);
      this._applyDimTo(el, { kind: ev.kind, linkId: ev.linkId, cls: link.cls });
    }
  }

  _drawPulse(ev, link, t) {
    let el = this.pulseByEvent.get(ev);
    if (!el) {
      el = this.pulsePool.pop();
      if (!el) {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'pulse dimmable');
        const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        halo.setAttribute('r', '7'); halo.setAttribute('opacity', '0.32');
        const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        core.setAttribute('r', '2.7');
        g.appendChild(halo); g.appendChild(core);
        el = g;
      }
      this.gPulses.node().appendChild(el);
      el.firstChild.setAttribute('fill', KIND_COLORS[ev.kind]);
      el.lastChild.setAttribute('fill', KIND_CORE[ev.kind]);
      el.setAttribute('data-kind', ev.kind);
      this.pulseByEvent.set(ev, el);
      this._applyDimTo(el, { kind: ev.kind, linkId: ev.linkId, cls: link.cls });
    }
    let u = (t - ev.t0) / (ev.t1 - ev.t0);
    if (ev.dir === -1) u = 1 - u;
    const [x, y] = link.pointAt(u);
    const sc = 0.65 + 0.7 * ev.intensity;
    el.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${sc.toFixed(2)})`);
  }

  _releaseDeadPulses(activeEvents) {
    if (this.pulseByEvent.size === 0) return;
    const active = new Set();
    for (const ev of activeEvents) if (ev.discrete) active.add(ev);
    for (const [ev, el] of this.pulseByEvent) {
      if (!active.has(ev)) {
        this.pulseByEvent.delete(ev);
        el.remove();
        el.removeAttribute('transform');
        this.pulsePool.push(el);
      }
    }
  }

  _updateRowGlow(rowGlow, nodeFlash) {
    for (const s of this.scene.servers) {
      const flash = nodeFlash.get(s.id) || 0;
      for (const row of s.rows) {
        const glow = rowGlow.get(row.id);
        let fill = GPU_BASE_FILL;
        if (flash > 0) {
          fill = this._mix(GPU_BASE_FILL, KIND_COLORS['weight-update'], 0.28 + 0.4 * flash);
        } else if (glow) {
          fill = this._mix(GPU_BASE_FILL, KIND_COLORS[glow.kind], 0.15 + 0.45 * glow.intensity);
        }
        if (this.rowFillCache.get(row.id) !== fill) {
          this.rowFillCache.set(row.id, fill);
          const rg = this.rowEls.get(row.id);
          for (const rect of rg.children) rect.style.fill = fill;
        }
      }
    }
  }

  _mix(a, b, k) {
    // quantize so the cache hits and we do not thrash attribute writes
    k = Math.round(k * 12) / 12;
    const key = a + b + k;
    this._mixCache = this._mixCache || new Map();
    let v = this._mixCache.get(key);
    if (!v) { v = d3.interpolateLab(a, b)(k); this._mixCache.set(key, v); }
    return v;
  }

  // ------------------------------------------------------------- rhythm strip
  _pushRhythmSample(t, v) {
    const r = this.rhythm;
    r.acc += v; r.accN++;
    if (t - r.lastT >= RHYTHM_DT) {
      r.samples.push([t, r.acc / r.accN]);
      r.acc = 0; r.accN = 0; r.lastT = t;
      const cutoff = t - RHYTHM_WINDOW - 1;
      while (r.samples.length && r.samples[0][0] < cutoff) r.samples.shift();
    }
  }

  _renderRhythm(t) {
    const { x, y, w, h } = RHYTHM;
    const plotX = x + 14, plotW = w - 28, plotTop = y + 52, plotBot = y + h - 12;
    const sx = (st) => plotX + plotW * (1 - (t - st) / RHYTHM_WINDOW);
    const sy = (v) => plotBot - Math.min(1, v / RHYTHM_VMAX) * (plotBot - plotTop);

    const mkPath = (samples, tRef) => {
      if (samples.length < 2) return ['', ''];
      let line = '', area = '';
      const sxr = (st) => plotX + plotW * (1 - (tRef - st) / RHYTHM_WINDOW);
      let first = null, lastX = null;
      for (const [st, v] of samples) {
        const px = sxr(st);
        if (px < plotX - 2) continue;
        const py = sy(v);
        if (first === null) { first = px; line = `M ${px.toFixed(1)} ${py.toFixed(1)}`; }
        else line += ` L ${px.toFixed(1)} ${py.toFixed(1)}`;
        lastX = px;
      }
      if (first === null) return ['', ''];
      area = line + ` L ${lastX.toFixed(1)} ${plotBot} L ${first.toFixed(1)} ${plotBot} Z`;
      return [line, area];
    };

    const [line, area] = mkPath(this.rhythm.samples, t);
    this.rhythmLine.setAttribute('d', line);
    this.rhythmArea.setAttribute('d', area);

    if (this.rhythm.ghost) {
      const g = this.rhythm.ghost;
      const tRef = g.length ? g[g.length - 1][0] : 0;
      const [gl, ga] = mkPath(g, tRef);
      this.rhythmGhostLine.setAttribute('d', gl);
      this.rhythmGhostArea.setAttribute('d', ga);
    } else {
      this.rhythmGhostLine.setAttribute('d', '');
      this.rhythmGhostArea.setAttribute('d', '');
    }
  }

  snapshotRhythmAsGhost() {
    if (this.rhythm.samples.length > 10) {
      this.rhythm.ghost = this.rhythm.samples.slice();
      this.rhythm.ghostMode = this.mode;
      d3.select(this.rhythmGhostLabel)
        .text(`ghost: previous ${this.rhythm.ghostMode} trace (for comparison)`);
    }
    this.rhythm.samples = [];
    this.rhythm.lastT = -Infinity;
  }

  // ----------------------------------------------------------------- dimming
  // spec: {servers:[], rows:[], links:[], linkClasses:[], actors:[], kinds:[]} or null
  setHighlight(spec) {
    this.highlightSpec = spec;
    const all = this.svg.node().querySelectorAll('.dimmable');
    if (!spec) {
      for (const el of all) el.classList.remove('dimmed');
      return;
    }
    for (const el of all) {
      el.classList.toggle('dimmed', !this._matches(el, spec));
    }
  }

  _matches(el, spec) {
    const server = el.getAttribute('data-server');
    if (server) return (spec.servers || []).includes(server);
    const actor = el.getAttribute('data-actor') || el.getAttribute('data-actor-label');
    if (actor) return (spec.actors || []).includes(actor);
    const poolLabel = el.getAttribute('data-pool-label');
    if (poolLabel) {
      const ids = spec.servers || [];
      return ids.some((id) => id.startsWith(poolLabel)) || (spec.actors || []).includes('pool' + poolLabel);
    }
    const linkId = el.getAttribute('data-link');
    if (linkId !== null) {
      const link = this.linkById.get(linkId);
      const kind = el.getAttribute('data-kind');
      return this._trafficMatches(kind, linkId, link ? link.cls : '', spec);
    }
    const kind = el.getAttribute('data-kind');
    if (kind) return (spec.kinds || []).includes(kind);
    return true;
  }

  _linkMatches(linkId, cls, spec) {
    return (spec.links || []).includes(linkId) || (spec.linkClasses || []).includes(cls);
  }

  // Traffic (flows/pulses): a non-empty kinds list is a hard filter — traffic
  // of other kinds is dimmed even on highlighted links.
  _trafficMatches(kind, linkId, cls, spec) {
    const kinds = spec.kinds || [];
    if (kind && kinds.length && !kinds.includes(kind)) return false;
    return this._linkMatches(linkId, cls, spec) || (kind && kinds.includes(kind));
  }

  _applyDimTo(el, { kind, linkId, cls }) {
    const spec = this.highlightSpec;
    if (!spec) { el.classList.remove('dimmed'); return; }
    el.classList.toggle('dimmed', !this._trafficMatches(kind, linkId, cls, spec));
  }
}
