// scenegraph.js — builds the full scene graph for a given cluster size:
// servers, GPUs, links (as SVG path strings + metadata), shared actors, and
// per-mode labeling. Node counts come from state, never hardcoded.

import { POOL, RAIL, ROUTER, USER, STORAGE, poolLayout, gpuOffsets, rowCenterY } from './layout.js';
import { PAR, STAGES, DEFAULT_COUNTS } from './config.js';

// counts: {nA, nB} — nodes in the left and right pool. KV/pipeline pairing is
// by "slot" k in 0..max(nA,nB)-1: slot k joins A_(k%nA) to B_(k%nB), so both
// pools stay fully used even when the counts differ.
export function buildScene(counts) {
  const { nA, nB } = counts;
  const nPair = Math.max(nA, nB);
  const geom = { A: poolLayout(nA), B: poolLayout(nB) };
  const servers = [];
  const links = [];
  const decor = [];

  for (const pool of ['A', 'B']) {
    const px = POOL[pool].x;
    const g = geom[pool];
    const offs = gpuOffsets(g);
    for (let i = 0; i < g.n; i++) {
      const ny = g.nodeY(i);
      const server = {
        id: `${pool}${i}`, pool, idx: i,
        x: px, y: ny, w: POOL.w, h: g.h,
        cx: px + POOL.w / 2, cy: g.nodeCY(i),
        rows: [],
      };
      for (let r = 0; r < PAR.rowsPerNode; r++) {
        const rowTop = ny + (r === 0 ? g.row0dy : g.row1dy);
        const rcy = rowCenterY(g, ny, r);
        const row = {
          id: `${pool}${i}r${r}`, server: server.id, pool, nodeIdx: i, rowIdx: r,
          y: rowTop, cy: rcy,
          gpus: offs.map((ox, gi) => ({
            id: `${pool}${i}r${r}g${gi}`,
            x: px + ox, y: rowTop, s: g.gpuS,
            cx: px + ox + g.gpuS / 2, cy: rcy,
          })),
        };
        row.x0 = row.gpus[0].cx;
        row.x1 = row.gpus[row.gpus.length - 1].cx;
        server.rows.push(row);
      }
      servers.push(server);

      // NVLink: thick line spanning each TP row (drawn behind the GPUs).
      // With TP=1 a row is a single GPU — no all-reduce, no rail.
      if (PAR.tp > 1) {
        for (const row of server.rows) {
          links.push({
            id: `nv-${row.id}`, cls: 'nvlink', from: row.id, to: row.id,
            d: `M ${row.x0} ${row.cy} L ${row.x1} ${row.cy}`,
          });
        }
      }
      // Pipeline hand-off inside the node: end of row 0 to start of row 1
      const r0 = server.rows[0], r1 = server.rows[1];
      const bend = 26 * g.k;
      links.push({
        id: `pp-${server.id}`, cls: 'fabric-pp', from: r0.id, to: r1.id,
        d: `M ${r0.x1} ${r0.cy} C ${r0.x1 + bend} ${r0.cy + 14 * g.k}, ${r1.x0 - bend} ${r1.cy - 14 * g.k}, ${r1.x0} ${r1.cy}`,
      });
    }
  }

  // Inter-pool fabric: one link per slot, A_(k%nA) right edge <-> B_(k%nB)
  // left edge. Straight when the endpoints align, a gentle S-curve otherwise.
  const ipx0 = POOL.A.x + POOL.w, ipx1 = POOL.B.x, midX = (ipx0 + ipx1) / 2;
  for (let k = 0; k < nPair; k++) {
    const a = k % nA, b = k % nB;
    const ya = geom.A.nodeCY(a), yb = geom.B.nodeCY(b);
    links.push({
      id: `ip-${k}`, cls: 'fabric-interpool', from: `A${a}`, to: `B${b}`,
      d: Math.abs(ya - yb) < 1
        ? `M ${ipx0} ${ya} L ${ipx1} ${yb}`
        : `M ${ipx0} ${ya} C ${midX} ${ya}, ${midX} ${yb}, ${ipx1} ${yb}`,
    });
  }

  // DP rails: vertical fabric on the outer flank of each pool, linking all
  // nodes (only meaningful with >1 node in the pool).
  for (const [pool, railId, rx] of [['A', 'dp-A', RAIL.Ax], ['B', 'dp-B', RAIL.Bx]]) {
    const g = geom[pool];
    if (g.n < 2) continue;
    links.push({
      id: railId, cls: 'fabric-interpool', from: `${pool}0`, to: `${pool}${g.n - 1}`,
      d: `M ${rx} ${g.nodeCY(0)} L ${rx} ${g.nodeCY(g.n - 1)}`, rail: true,
    });
    const edgeX = pool === 'A' ? POOL.A.x : POOL.B.x + POOL.w;
    for (let i = 0; i < g.n; i++) {
      decor.push({ railId, x1: rx, y1: g.nodeCY(i), x2: edgeX, y2: g.nodeCY(i) });
    }
  }

  // Storage links: one aggregated fabric link per pool down to the storage tier
  const stTop = STORAGE.y + 2;
  const botA = geom.A.bottom, botB = geom.B.bottom;
  links.push({
    id: 'st-A', cls: 'fabric-storage', from: `A${nA - 1}`, to: 'storage',
    d: `M ${POOL.A.x + POOL.w - 90} ${botA} C ${POOL.A.x + POOL.w - 60} ${botA + 40}, ${STORAGE.cx - 60} ${stTop - 36}, ${STORAGE.cx - 34} ${stTop}`,
  });
  links.push({
    id: 'st-B', cls: 'fabric-storage', from: `B${nB - 1}`, to: 'storage',
    d: `M ${POOL.B.x + 90} ${botB} C ${POOL.B.x + 60} ${botB + 40}, ${STORAGE.cx + 60} ${stTop - 36}, ${STORAGE.cx + 34} ${stTop}`,
  });

  // Ingress: user -> router, router -> each pool-A node
  const rRight = ROUTER.x + ROUTER.w, rMidY = ROUTER.y + ROUTER.h / 2;
  links.push({
    id: 'in-user', cls: 'fabric-ext', from: 'user', to: 'router',
    d: `M ${USER.cx + USER.r} ${USER.cy} L ${ROUTER.x} ${rMidY}`,
  });
  for (let i = 0; i < nA; i++) {
    const ty = geom.A.nodeCY(i);
    links.push({
      id: `in-r${i}`, cls: 'fabric-ext', from: 'router', to: `A${i}`,
      d: `M ${rRight} ${rMidY} C ${rRight + 38} ${rMidY}, ${POOL.A.x - 38} ${ty}, ${POOL.A.x} ${ty}`,
    });
  }

  // Token return: B_i right edge, up the flank, across the top, into the router
  const rTopX = ROUTER.x + ROUTER.w / 2;
  for (let i = 0; i < nB; i++) {
    const cy = geom.B.nodeCY(i);
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

  return {
    servers, links, decor,
    counts: { nA, nB, nPair },
    actors: { user: USER, router: ROUTER, storage: STORAGE },
  };
}

// ---------------------------------------------------------------------------
// Per-mode labeling and tooltip metadata. The geometry never changes meaning;
// every string with a parallelism number in it is derived from PAR/counts so
// labels can never drift from the actual cluster shape.
// ---------------------------------------------------------------------------

export function modeMeta(mode, counts = DEFAULT_COUNTS) {
  return mode === 'training' ? trainingMeta(counts) : inferenceMeta(counts);
}

function inferenceMeta(counts) {
  const instSub = (n) =>
    `${n} instance${n === 1 ? '' : 's'} · TP=${PAR.tp} · PP=${PAR.rowsPerNode} per instance — one per node`;
  return {
    poolA: { title: 'Prefill cluster', sub: instSub(counts.prefill) },
    poolB: { title: 'Decode cluster', sub: instSub(counts.decode) },
    user: { label: 'Users', tip: { name: 'Users', role: 'Source of chat/API requests. Arrivals are bursty and uncoordinated (Poisson-like).' } },
    router: { label: 'Router + tokenizer', tip: { name: 'Router + tokenizer', role: 'Tokenizes prompts and dispatches each request to a prefill instance; streams generated tokens back to users.' } },
    storage: { label: 'KV cache pool', tip: { name: 'KV cache storage tier', role: 'Holds evicted / reusable KV prefixes. Fetched on prefix-cache hits before prefill; flushed after some requests finish.' } },
    footnote: 'Parallelism shapes are illustrative — real deployments often choose different TP/PP shapes for prefill vs. decode.',
    serverTip: (s) => s.pool === 'A'
      ? { name: `Prefill instance ${s.idx}`, role: 'Compute-bound: processes the whole prompt in one dense pass. TP all-reduces on NVLink, activations hop between its two pipeline stages, and KV pages stream out to its decode partner while prefill runs.' }
      : { name: `Decode instance ${s.idx}`, role: 'Memory-bandwidth-bound: generates one token at a time. Low, steady TP traffic on NVLink; a thin trickle of tokens returns to the router.' },
    rowTip: (r) => ({
      name: `${PAR.tp > 1 ? 'TP group' : 'Pipeline stage'} — ${r.pool === 'A' ? 'prefill' : 'decode'} instance ${r.nodeIdx}, stage ${r.rowIdx}`,
      role: PAR.tp > 1
        ? `${PAR.tp} GPUs holding one layer-shard each. Every layer requires an all-reduce across this row — it stays on NVLink and never touches the datacenter fabric.`
        : 'A single GPU — at this model size the whole stage fits in one GPU’s memory, so no tensor parallelism (and no NVLink all-reduce) is needed.',
    }),
    linkTip: {
      nvlink: { name: 'NVLink (intra-node)', role: 'Carries tensor-parallel all-reduces. Invisible to the datacenter network fabric.' },
      'fabric-pp': { name: 'Pipeline hand-off', role: 'Activations passed from pipeline stage 0 to stage 1 within the instance.' },
      'fabric-interpool': { name: 'Inter-pool fabric', role: 'One-way KV-cache stream: prefill pushes KV pages to its decode partner, layer by layer, while prefill is still running.' },
      'fabric-storage': { name: 'Storage fabric', role: 'KV prefix fetches (storage → prefill) on cache hits; KV flushes (decode → storage) after some completions.' },
      'fabric-ext': { name: 'Ingress / egress', role: 'Requests in from users via the router; generated tokens trickling back out.' },
    },
  };
}

function trainingMeta(counts) {
  const R = counts.replicas;
  return {
    poolA: {
      title: `Training job — pipeline stages ${STAGES.A}`,
      sub: `DP=${R} replica${R === 1 ? '' : 's'} · PP=${PAR.ppDepth} per replica (${PAR.rowsPerNode} stages/node) · TP=${PAR.tp} per row`,
    },
    poolB: { title: `Training job — pipeline stages ${STAGES.B}`, sub: 'Same job, same step clock — every replica advances in lockstep' },
    user: { label: 'Training data shards', tip: { name: 'Training data', role: 'Sharded dataset feeding the job. Batches are prefetched, so this path is quiet compared to the gradient traffic.' } },
    router: { label: 'Training orchestrator', tip: { name: 'Training orchestrator', role: 'Coordinates the global step: launches the job, monitors stragglers, triggers checkpoints. Control-plane only — the heavy traffic is GPU-to-GPU.' } },
    storage: { label: 'Checkpoint / data storage', tip: { name: 'Checkpoint storage', role: 'Receives periodic full-model checkpoints (every ~8 steps here) and serves training data.' } },
    footnote: `Row i of the two pools together form data-parallel replica i: local stages ${STAGES.A} in the left node, ${STAGES.B} in the right — PP=${PAR.ppDepth} end to end.`,
    serverTip: (s) => ({
      name: `Replica ${s.idx} — pipeline stages ${STAGES[s.pool]} (local)`,
      role: `Hosts ${PAR.rowsPerNode} of this replica's ${PAR.ppDepth} pipeline stages. Forward activations sweep through it left→right, gradients sweep back right→left, then it joins the global gradient all-reduce.`,
    }),
    rowTip: (r) => ({
      name: `${PAR.tp > 1 ? 'TP group' : 'Pipeline stage'} — replica ${r.nodeIdx}, pipeline stage ${(r.pool === 'B' ? PAR.rowsPerNode : 0) + r.rowIdx} of ${PAR.ppDepth}`,
      role: PAR.tp > 1
        ? `${PAR.tp} GPUs sharding this stage's layers. TP all-reduces stay on NVLink; everything else this row does is on the shared step clock.`
        : 'A single GPU holding this whole stage — the model is small enough that no tensor sharding is needed. Everything it does is on the shared step clock.',
    }),
    linkTip: {
      nvlink: { name: 'NVLink (intra-node)', role: 'Tensor-parallel all-reduces during forward and backward passes. High intensity, but invisible to the fabric.' },
      'fabric-pp': { name: 'Pipeline link', role: 'Activations forward, gradients backward, between adjacent pipeline stages.' },
      'fabric-interpool': { name: 'Data-parallel fabric', role: 'Carries the gradient all-reduce: every replica exchanges gradients with every other, simultaneously and bidirectionally, once per step. The loudest event in the datacenter.' },
      'fabric-storage': { name: 'Storage fabric', role: 'Periodic checkpoint writes (every ~8 steps) and training-data reads.' },
      'fabric-ext': { name: 'Control plane', role: 'Orchestrator control traffic — negligible bandwidth, shown for completeness.' },
    },
  };
}
