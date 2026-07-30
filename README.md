# comms-viz — Datacenter Communication Patterns: Training vs. Inference

An interactive, animated bird's-eye view of GPU-to-GPU data flow in a frontier
AI datacenter, under two workloads on the **same hardware**:

- **Disaggregated inference** — prefill/decode separation: asymmetric,
  feed-forward, Poisson-bursty, no global synchronization.
- **Training (3D parallelism)** — DP × PP × TP: a periodic, globally
  synchronized, bidirectional heartbeat.

The pedagogical payload is the *contrast in communication cadence and
symmetry*. The scrolling "rhythm strip" at the bottom shows aggregate fabric
traffic — literally what an external observer of the cable plant would see:
ragged noise for inference, a metronomic comb for training. That observable
distinction is the basis of a treaty-verification research argument.

Interaction style inspired by [bbycroft/llm-viz](https://github.com/bbycroft/llm-viz)
(guided walkthrough + synchronized commentary + play/pause), but rendered
entirely in 2D SVG with vanilla JS + D3. No build step, no backend.

## Usage

Serve statically and open in a browser:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

(or `npx serve`). Opening `index.html` directly via `file://` will not work —
the walkthrough JSON is fetched at runtime.

**Controls:** mode toggle (Inference/Training), play/pause (space), speed
slider (0.25×–4×), **GPU selector** (NVIDIA B200 for now — its 192 GB HBM3e
capacity is what the tensor-parallel width is derived from), **model-size
selector** (8B/70B/400B/1T or custom — drives the byte estimates in link
tooltips *and* the derived TP, shown as a `→ TP=n` readout), **cluster-size
steppers** (1–8 prefill + decode instances in inference, 1–8 data-parallel
replicas in training; layout, traffic, labels, and tour copy all rescale),
**Guided tour** (step-by-step walkthrough with commentary; ←/→ keys), legend
toggle, and **What this lies about**. Hover any component for its role in the current mode; hovering a
*link* also shows a live byte estimate for whatever is in flight on it right
now ("≈2.1 GB of 23 GB streamed — KV pages · ~layer 12/127"), or "idle right
now". Add `?debug` to the URL for a frame-time overlay.

### Byte estimates are order-of-magnitude approximations

`js/modelprofile.js` derives a transformer shape from the chosen parameter
count using standard scaling heuristics — **not** any published config:
params ≈ 12·L·H² with L ≈ H/128; KV cache = 2·L·H·2 bytes/token (full
multi-head attention, no GQA/MLA — real serving stacks are often ~10× smaller);
gradient all-reduce payload = 2 bytes/param (bf16); checkpoint ≈ 14 bytes/param
(bf16 weights + fp32 master + Adam moments). The relationships scale correctly
with model size; individual numbers are illustrative. Rates shown in tooltips
are per the animation's stylized durations, not real link speeds.

### Tensor parallelism is derived from GPU memory

The cluster is assumed to be built from **NVIDIA B200s (192 GB HBM3e)**.
Inference is the binding constraint: each serving instance splits the model
over 2 pipeline stages, so one stage's bf16 weight shard is `2·params / (2·TP)`
per GPU. TP is chosen as the smallest power of two (max 8, one NVLink row)
whose shard fits in 75% of GPU memory — the rest is headroom for KV cache and
activations. Concretely: 8B and 70B → TP=1 (a whole stage fits on one B200, so
the NVLink rails sit dark and the tour copy adapts), 400B → TP=4, 1T → TP=8.
Past ~1.15T params the model no longer fits this fixed pod shape at any TP;
the `→ TP=8 ⚠` readout flags it.

## Development

- Vanilla ES modules in `js/`, D3 v7 vendored in `vendor/`. No bundler.
- `js/traffic.js` generates stylized `TransferEvent`s per mode; the event
  interface is kept clean so a trace-driven generator could be swapped in.
- `js/renderer.js` draws the scene and animates everything from a single
  master clock (one `requestAnimationFrame` loop; no D3 transitions for
  traffic).

### Visual testing

```sh
npm install            # playwright
node screenshot.mjs    # default suite → screenshots/*.png
node screenshot.mjs --mode training --t 22.5 --out ar.png
node screenshot.mjs --mode inference --t 5 --step 3 --out tour3.png
node screenshot.mjs --mode inference --t 30 --then-mode training --t2 15 --out ghost.png
node screenshot.mjs --mode training --t 8.6 --counts "replicas=8" --out r8.png
node screenshot.mjs --mode inference --t 6 --model 1e12 --out tp8.png
```

The harness serves the site, advances the deterministic sim clock headlessly,
and captures 1600×952 PNGs.

## Deploying to GitHub Pages

The site is fully static with relative paths. Either:

1. Repo **Settings → Pages → Deploy from a branch**, pick `main` and `/ (root)`;
   or
2. serve from a subfolder — copy `index.html`, `css/`, `js/`, `data/`,
   `vendor/` into it and point Pages there.

No build step required. (`node_modules/` and `screenshots/` are dev-only and
git-ignored.)

## What this animation lies about

This is a stylized explainer, not a simulation. Known lies, in order of size:

1. **Scale** — a frontier cluster has tens of thousands of GPUs; the few
   dozen here are one "pod" standing in for the whole.
2. **No mixture-of-experts** — MoE adds a large all-to-all exchange inside
   every layer, in both workloads. Not shown.
3. **Disaggregation is one design point** — colocated and chunked-prefill
   serving mix both phases on the same GPUs. Those alternatives are not shown.
4. **Stylized timings** — durations are hand-tuned for legibility (~1 s of
   wall-clock "datacenter time" per real second), not measured.
5. **TP as generic shimmer** — tensor-parallel traffic is really a precise
   per-layer sequence of all-reduces, not a continuous glow.
6. **Fixed prefill→decode pairing** — real routers pick decode instances by
   load; here each prefill node ships KV to a fixed partner for legibility.
7. **No congestion** — links never queue, drop, or interfere.
8. **Training shown un-overlapped** — real frameworks overlap gradient
   communication with the backward pass, which partially smears (but does not
   erase) the heartbeat.

## License

MIT.
