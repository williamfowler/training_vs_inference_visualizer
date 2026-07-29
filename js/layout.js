// layout.js — geometry constants and coordinate helpers.
// Pool geometry is computed from the live node count: node boxes shrink
// proportionally (with their GPUs) when a pool holds more than 4 nodes, so the
// stack always fits the fixed 1600x900 viewBox.

import { PAR } from './config.js';

export const VIEW = { w: 1600, h: 900 };

export const POOL = {
  A: { x: 360 },
  B: { x: 940 },
  w: 340,
};

export const RAIL = { Ax: 344, Bx: 1296 };   // DP rail x positions (outer flanks)

export const ROUTER = { x: 150, y: 118, w: 145, h: 72 };
export const USER = { cx: 85, cy: 154, r: 34 };
export const STORAGE = { cx: 820, y: 600, w: 130, h: 72 };

export const RHYTHM = { x: 40, y: 690, w: 1200, h: 186 };
export const LEGEND = { x: 1290, y: 690, w: 300, h: 186 };

// Reference node geometry at count <= 4 (the original fixed layout).
const BASE = {
  h: 100, gap: 16,
  top: 88, bot: 560,          // vertical band the node stack must fit inside
  gpuS: 30, row0dy: 14, row1dy: 56, padX: 22,
};

// Per-pool layout for n nodes: scale factor k shrinks boxes/GPUs/spacing
// together once n*base height exceeds the band; smaller stacks are centered.
export function poolLayout(n) {
  const span = BASE.bot - BASE.top;
  const need = n * BASE.h + (n - 1) * BASE.gap;
  const k = Math.min(1, span / need);
  const h = BASE.h * k, gap = BASE.gap * k;
  const used = n * h + (n - 1) * gap;
  const top = BASE.top + (span - used) / 2;
  return {
    n, k, h, gap, top,
    gpuS: BASE.gpuS * k,
    row0dy: BASE.row0dy * k,
    row1dy: BASE.row1dy * k,
    nodeY: (i) => top + i * (h + gap),
    nodeCY: (i) => top + i * (h + gap) + h / 2,
    bottom: top + used,
  };
}

// GPU left offsets within a node: evenly spread PAR.tp squares
export function gpuOffsets(g) {
  const first = BASE.padX;
  const last = POOL.w - BASE.padX - g.gpuS;
  const step = (last - first) / (PAR.tp - 1);
  return Array.from({ length: PAR.tp }, (_, i) => first + i * step);
}

export function rowCenterY(g, nodeTop, row) {
  return nodeTop + (row === 0 ? g.row0dy : g.row1dy) + g.gpuS / 2;
}
