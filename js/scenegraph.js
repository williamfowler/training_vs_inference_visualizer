// scenegraph.js — builds the full static scene graph: servers, GPUs, links
// (as SVG path strings + metadata), shared actors, and per-mode labeling.

import { POOL, NODE, GPU, RAIL, ROUTER, USER, STORAGE, nodeY, nodeCY, gpuOffsets, rowCenterY } from './layout.js';

export function buildScene() {
  const servers = [];
  const links = [];
  const offs = gpuOffsets();

  for (const pool of ['A', 'B']) {
    const px = POOL[pool].x;
    for (let i = 0; i < NODE.perPool; i++) {
      const ny = nodeY(i);
      const server = {
        id: `${pool}${i}`, pool, idx: i,
        x: px, y: ny, w: POOL.w, h: NODE.h,
        cx: px + POOL.w / 2, cy: ny + NODE.h / 2,
        rows: [],
      };
      for (let r = 0; r < 2; r++) {
        const rowTop = ny + (r === 0 ? GPU.row0dy : GPU.row1dy);
        const rcy = rowCenterY(ny, r);
        const row = {
          id: `${pool}${i}r${r}`, server: server.id, pool, nodeIdx: i, rowIdx: r,
          y: rowTop, cy: rcy,
          gpus: offs.map((ox, g) => ({
            id: `${pool}${i}r${r}g${g}`,
            x: px + ox, y: rowTop, s: GPU.s,
            cx: px + ox + GPU.s / 2, cy: rcy,
          })),
        };
        row.x0 = row.gpus[0].cx;
        row.x1 = row.gpus[GPU.perRow - 1].cx;
        server.rows.push(row);
      }
      servers.push(server);

      // NVLink: thick line spanning each TP row (drawn behind the GPUs)
      for (let r = 0; r < 2; r++) {
        const row = server.rows[r];
        links.push({
          id: `nv-${row.id}`, cls: 'nvlink', from: row.id, to: row.id,
          d: `M ${row.x0} ${row.cy} L ${row.x1} ${row.cy}`,
        });
      }
      // Pipeline hand-off inside the node: end of row 0 to start of row 1
      const r0 = server.rows[0], r1 = server.rows[1];
      links.push({
        id: `pp-${server.id}`, cls: 'fabric-pp', from: r0.id, to: r1.id,
        d: `M ${r0.x1} ${r0.cy} C ${r0.x1 + 26} ${r0.cy + 14}, ${r1.x0 - 26} ${r1.cy - 14}, ${r1.x0} ${r1.cy}`,
      });
    }
  }

  // Inter-pool fabric bundle: A_i right edge <-> B_i left edge
  for (let i = 0; i < NODE.perPool; i++) {
    const cy = nodeCY(i);
    links.push({
      id: `ip-${i}`, cls: 'fabric-interpool', from: `A${i}`, to: `B${i}`,
      d: `M ${POOL.A.x + POOL.w} ${cy} L ${POOL.B.x} ${cy}`,
    });
  }

  // DP rails: vertical fabric on the outer flank of each pool, linking all nodes
  const railTop = nodeCY(0), railBot = nodeCY(NODE.perPool - 1);
  links.push({ id: 'dp-A', cls: 'fabric-interpool', from: 'A0', to: 'A3',
               d: `M ${RAIL.Ax} ${railTop} L ${RAIL.Ax} ${railBot}`, rail: true });
  links.push({ id: 'dp-B', cls: 'fabric-interpool', from: 'B0', to: 'B3',
               d: `M ${RAIL.Bx} ${railTop} L ${RAIL.Bx} ${railBot}`, rail: true });

  // Storage links: one aggregated fabric link per pool down to the storage tier
  const stTop = STORAGE.y + 2;
  const lastBot = nodeY(NODE.perPool - 1) + NODE.h;
  links.push({
    id: 'st-A', cls: 'fabric-storage', from: 'A3', to: 'storage',
    d: `M ${POOL.A.x + POOL.w - 90} ${lastBot} C ${POOL.A.x + POOL.w - 60} ${lastBot + 40}, ${STORAGE.cx - 60} ${stTop - 36}, ${STORAGE.cx - 34} ${stTop}`,
  });
  links.push({
    id: 'st-B', cls: 'fabric-storage', from: 'B3', to: 'storage',
    d: `M ${POOL.B.x + 90} ${lastBot} C ${POOL.B.x + 60} ${lastBot + 40}, ${STORAGE.cx + 60} ${stTop - 36}, ${STORAGE.cx + 34} ${stTop}`,
  });

  // Ingress: user -> router, router -> each pool-A node
  const rRight = ROUTER.x + ROUTER.w, rMidY = ROUTER.y + ROUTER.h / 2;
  links.push({
    id: 'in-user', cls: 'fabric-ext', from: 'user', to: 'router',
    d: `M ${USER.cx + USER.r} ${USER.cy} L ${ROUTER.x} ${rMidY}`,
  });
  for (let i = 0; i < NODE.perPool; i++) {
    const ty = nodeCY(i);
    links.push({
      id: `in-r${i}`, cls: 'fabric-ext', from: 'router', to: `A${i}`,
      d: `M ${rRight} ${rMidY} C ${rRight + 38} ${rMidY}, ${POOL.A.x - 38} ${ty}, ${POOL.A.x} ${ty}`,
    });
  }

  // Token return: B_i right edge, up the flank, across the top, into the router
  const rTopX = ROUTER.x + ROUTER.w / 2;
  for (let i = 0; i < NODE.perPool; i++) {
    const cy = nodeCY(i);
    const lane = 1338 + i * 5;          // parallel lanes so returns do not overlap
    const laneY = 26 + i * 5;
    links.push({
      id: `ret-${i}`, cls: 'fabric-ext', from: `B${i}`, to: 'router', ret: true,
      d: `M ${POOL.B.x + POOL.w} ${cy} Q ${lane} ${cy}, ${lane} ${cy - 46} ` +
         `L ${lane} ${laneY + 26} Q ${lane} ${laneY}, ${lane - 30} ${laneY} ` +
         `L ${rTopX + 40} ${laneY} Q ${rTopX} ${laneY}, ${rTopX} ${laneY + 40} ` +
         `L ${rTopX} ${ROUTER.y}`,
    });
  }

  return { servers, links, actors: { user: USER, router: ROUTER, storage: STORAGE } };
}

// ---------------------------------------------------------------------------
// Per-mode labeling and tooltip metadata. The geometry never changes; the
// meaning of every component does.
// ---------------------------------------------------------------------------

export const MODE_META = {
  inference: {
    poolA: { title: 'Prefill cluster', sub: 'TP=4 · PP=2 per instance — one instance per node' },
    poolB: { title: 'Decode cluster', sub: 'TP=4 · PP=2 per instance — one instance per node' },
    user: { label: 'Users', tip: { name: 'Users', role: 'Source of chat/API requests. Arrivals are bursty and uncoordinated (Poisson-like).' } },
    router: { label: 'Router + tokenizer', tip: { name: 'Router + tokenizer', role: 'Tokenizes prompts and dispatches each request to a prefill instance; streams generated tokens back to users.' } },
    storage: { label: 'KV cache pool', tip: { name: 'KV cache storage tier', role: 'Holds evicted / reusable KV prefixes. Fetched on prefix-cache hits before prefill; flushed after some requests finish.' } },
    footnote: 'Parallelism shapes are illustrative — real deployments often choose different TP/PP shapes for prefill vs. decode.',
    serverTip: (s) => s.pool === 'A'
      ? { name: `Prefill instance ${s.idx}`, role: 'Compute-bound: processes the whole prompt in one dense pass. TP all-reduces on NVLink, activations hop between its two pipeline stages, and KV pages stream out to its decode partner while prefill runs.' }
      : { name: `Decode instance ${s.idx}`, role: 'Memory-bandwidth-bound: generates one token at a time. Low, steady TP traffic on NVLink; a thin trickle of tokens returns to the router.' },
    rowTip: (r) => ({ name: `TP group — ${r.pool === 'A' ? 'prefill' : 'decode'} instance ${r.nodeIdx}, stage ${r.rowIdx}`, role: '4 GPUs holding one layer-shard each. Every layer requires an all-reduce across this row — it stays on NVLink and never touches the datacenter fabric.' }),
    linkTip: {
      nvlink: { name: 'NVLink (intra-node)', role: 'Carries tensor-parallel all-reduces. Invisible to the datacenter network fabric.' },
      'fabric-pp': { name: 'Pipeline hand-off', role: 'Activations passed from pipeline stage 0 to stage 1 within the instance.' },
      'fabric-interpool': { name: 'Inter-pool fabric', role: 'One-way KV-cache stream: prefill pushes KV pages to its decode partner, layer by layer, while prefill is still running.' },
      'fabric-storage': { name: 'Storage fabric', role: 'KV prefix fetches (storage → prefill) on cache hits; KV flushes (decode → storage) after some completions.' },
      'fabric-ext': { name: 'Ingress / egress', role: 'Requests in from users via the router; generated tokens trickling back out.' },
    },
  },
  training: {
    poolA: { title: 'Training job — pipeline stages 0–1', sub: 'DP=4 replicas · each replica spans 2 nodes (PP=2) · TP=4 per row' },
    poolB: { title: 'Training job — pipeline stages 2–3', sub: 'Same job, same step clock — every replica advances in lockstep' },
    user: { label: 'Training data shards', tip: { name: 'Training data', role: 'Sharded dataset feeding the job. Batches are prefetched, so this path is quiet compared to the gradient traffic.' } },
    router: { label: 'Training orchestrator', tip: { name: 'Training orchestrator', role: 'Coordinates the global step: launches the job, monitors stragglers, triggers checkpoints. Control-plane only — the heavy traffic is GPU-to-GPU.' } },
    storage: { label: 'Checkpoint / data storage', tip: { name: 'Checkpoint storage', role: 'Receives periodic full-model checkpoints (every ~8 steps here) and serves training data.' } },
    footnote: 'Row i of the two pools together form data-parallel replica i: stages 0–1 in the left node, stages 2–3 in the right node.',
    serverTip: (s) => ({ name: `Replica ${s.idx} — ${s.pool === 'A' ? 'pipeline stages 0–1' : 'pipeline stages 2–3'}`, role: 'One pipeline slice of data-parallel replica ' + s.idx + '. Forward activations sweep through it left→right, gradients sweep back right→left, then it joins the global gradient all-reduce.' }),
    rowTip: (r) => ({ name: `TP group — replica ${r.nodeIdx}, pipeline stage ${(r.pool === 'B' ? 2 : 0) + r.rowIdx}`, role: '4 GPUs sharding this stage\'s layers. TP all-reduces stay on NVLink; everything else this row does is on the shared step clock.' }),
    linkTip: {
      nvlink: { name: 'NVLink (intra-node)', role: 'Tensor-parallel all-reduces during forward and backward passes. High intensity, but invisible to the fabric.' },
      'fabric-pp': { name: 'Pipeline link', role: 'Activations forward, gradients backward, between adjacent pipeline stages.' },
      'fabric-interpool': { name: 'Data-parallel fabric', role: 'Carries the gradient all-reduce: every replica exchanges gradients with every other, simultaneously and bidirectionally, once per step. The loudest event in the datacenter.' },
      'fabric-storage': { name: 'Storage fabric', role: 'Periodic checkpoint writes (every ~8 steps) and training-data reads.' },
      'fabric-ext': { name: 'Control plane', role: 'Orchestrator control traffic — negligible bandwidth, shown for completeness.' },
    },
  },
};
