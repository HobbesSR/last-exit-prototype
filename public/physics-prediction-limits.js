// Engine-free so presentation and replay can share thresholds without loading WASM.
// Independent of server queue trimming: stalled frames cut bounded prediction.
export const PREDICTION_LIMITS = Object.freeze({
  inputs: 32, frames: 32, replay: 8, statics: 512, proxies: 128,
  staleMs: 500, eyeSnapMs: 200,
});
