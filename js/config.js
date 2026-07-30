// config.js — single source of truth for cluster shape. Every label, tooltip,
// and traffic loop derives its numbers from here so they can never drift.

export const PAR = {
  tp: 4,               // GPUs per tensor-parallel row — derived from model size vs GPU memory
  rowsPerNode: 2,      // pipeline stages hosted locally on one node
  nodesPerReplica: 2,  // training: one replica spans an A-node + a B-node
};
PAR.ppDepth = PAR.rowsPerNode * PAR.nodesPerReplica;   // replica-wide PP depth
PAR.gpusPerNode = PAR.tp * PAR.rowsPerNode;

// TP is the one dimension that tracks the model/GPU choice; everything reading
// PAR picks the new value up on the next scene rebuild / traffic reset.
export function setTensorParallel(tp) {
  PAR.tp = tp;
  PAR.gpusPerNode = PAR.tp * PAR.rowsPerNode;
}

// GPU catalog. Memory capacity is the ground truth that determines the
// tensor-parallel width (see deriveTP in modelprofile.js). B200: 192 GB HBM3e,
// 8 TB/s memory bandwidth (NVIDIA Blackwell published specs).
export const GPU_CATALOG = [
  { id: 'b200', label: 'NVIDIA B200', memBytes: 192e9, memLabel: '192 GB HBM3e', bwBytesPerSec: 8e12 },
];
export const DEFAULT_GPU = 'b200';

// pipeline-stage ranges as strings, by pool
export const STAGES = {
  A: `0–${PAR.rowsPerNode - 1}`,
  B: `${PAR.rowsPerNode}–${PAR.ppDepth - 1}`,
};

export const COUNT_BOUNDS = { min: 1, max: 8 };
export const DEFAULT_COUNTS = { prefill: 4, decode: 4, replicas: 4 };
