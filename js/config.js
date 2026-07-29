// config.js — single source of truth for cluster shape. Every label, tooltip,
// and traffic loop derives its numbers from here so they can never drift.

export const PAR = {
  tp: 4,               // GPUs per tensor-parallel row
  rowsPerNode: 2,      // pipeline stages hosted locally on one node
  nodesPerReplica: 2,  // training: one replica spans an A-node + a B-node
};
PAR.ppDepth = PAR.rowsPerNode * PAR.nodesPerReplica;   // replica-wide PP depth
PAR.gpusPerNode = PAR.tp * PAR.rowsPerNode;

// pipeline-stage ranges as strings, by pool
export const STAGES = {
  A: `0–${PAR.rowsPerNode - 1}`,
  B: `${PAR.rowsPerNode}–${PAR.ppDepth - 1}`,
};

export const COUNT_BOUNDS = { min: 1, max: 8 };
export const DEFAULT_COUNTS = { prefill: 4, decode: 4, replicas: 4 };
