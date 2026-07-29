// modelprofile.js — order-of-magnitude transformer sizing from a parameter
// count. These are documented APPROXIMATIONS, not published configs: the point
// is that every derived byte size scales the right way with model size, not
// that any single number matches a real deployment.
//
// Assumptions (dense decoder-only transformer, bf16 activations/weights):
//   params ≈ 12 · L · H²          (attention 4H² + MLP 8H² per layer)
//   L ≈ H / 128                   (typical depth/width aspect ratio)
//   ⇒ H ≈ cbrt(32 · params / 3), rounded to a multiple of 128
//   KV cache/token = 2 · L · H · 2 bytes     (K+V, full MHA — no GQA/MLA)
//   activations/token at a pipeline cut = H · 2 bytes
//   gradient all-reduce payload = params · 2 bytes (bf16 grads)
//   checkpoint = params · 14 bytes (bf16 weights + fp32 master + Adam m, v)

export const MODEL_PRESETS = [
  { id: '8b',   label: '8B',   params: 8e9 },
  { id: '70b',  label: '70B',  params: 70e9 },
  { id: '400b', label: '400B', params: 400e9 },
  { id: '1t',   label: '1T',   params: 1e12 },
];

export function deriveProfile(params) {
  const hRaw = Math.cbrt((32 * params) / 3);
  const hiddenSize = Math.max(1024, Math.round(hRaw / 128) * 128);
  const numLayers = Math.max(4, Math.round(hiddenSize / 128));
  return {
    params,
    hiddenSize,
    numLayers,
    bytesPerParam: 2,
    kvBytesPerToken: 2 * numLayers * hiddenSize * 2,
    activationBytesPerToken: hiddenSize * 2,
    // one layer's TP all-reduce payload per token (2 all-reduces × H × bf16)
    tpBytesPerTokenLayer: 2 * hiddenSize * 2,
    weightBytesTotal: params * 2,
    gradBytesTotal: params * 2,
    checkpointBytes: params * 14,
  };
}

// "≈2.6 MB" style formatting, 2-3 significant figures
export function fmtBytes(b) {
  if (b == null || !isFinite(b)) return '?';
  const units = [['TB', 1e12], ['GB', 1e9], ['MB', 1e6], ['KB', 1e3]];
  for (const [u, k] of units) {
    if (b >= k) {
      const v = b / k;
      return (v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + u;
    }
  }
  return Math.round(b) + ' B';
}
