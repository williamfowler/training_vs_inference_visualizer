// layout.js — geometry constants and coordinate helpers for the fixed scene.
// One layout is shared by both modes; only labels/traffic reinterpret it.

export const VIEW = { w: 1600, h: 900 };

export const POOL = {
  A: { x: 360 },
  B: { x: 940 },
  w: 340,
};

export const NODE = {
  h: 100,
  gap: 16,
  firstY: 88,
  perPool: 4,
};

export const GPU = {
  s: 30,           // square side
  padX: 22,        // left/right padding inside node box
  row0dy: 14,      // top of row 0 within node
  row1dy: 56,      // top of row 1 within node
  perRow: 4,
};

export const RAIL = { Ax: 344, Bx: 1296 };   // DP rail x positions (outer flanks)

export const ROUTER = { x: 150, y: 118, w: 145, h: 72 };
export const USER = { cx: 85, cy: 154, r: 34 };
export const STORAGE = { cx: 820, y: 600, w: 130, h: 72 };

export const RHYTHM = { x: 40, y: 690, w: 1200, h: 186 };
export const LEGEND = { x: 1290, y: 690, w: 300, h: 186 };

export function nodeY(i) { return NODE.firstY + i * (NODE.h + NODE.gap); }
export function nodeX(pool) { return POOL[pool].x; }
export function nodeCY(i) { return nodeY(i) + NODE.h / 2; }

// GPU left offsets within a node: evenly spread 4 squares
export function gpuOffsets() {
  const first = GPU.padX;
  const last = POOL.w - GPU.padX - GPU.s;
  const step = (last - first) / (GPU.perRow - 1);
  return Array.from({ length: GPU.perRow }, (_, i) => first + i * step);
}

export function rowCenterY(nodeTop, row) {
  return nodeTop + (row === 0 ? GPU.row0dy : GPU.row1dy) + GPU.s / 2;
}
