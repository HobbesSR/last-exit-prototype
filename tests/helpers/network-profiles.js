// The network profiles the transport studies share (rtt ms, mean exponential jitter ms on each one-way trip,
// independent loss). The first five are 42.48's. `bursty` is 42.50's: Gilbert-Elliott over 50 ms send slots, `loss`
// of slots lost with a mean outage of `burst` slots, at typical's rtt and jitter. `poor-lossless` is 42.56's control,
// poor's delays without its loss, run only when named.
export const NETWORK_PROFILES = Object.freeze([
  { name: 'lan', rtt: 4, jitter: 1, loss: 0 },
  { name: 'good', rtt: 40, jitter: 4, loss: 0.002 },
  { name: 'typical', rtt: 80, jitter: 12, loss: 0.01 },
  { name: 'wifi', rtt: 120, jitter: 35, loss: 0.03 },
  { name: 'poor', rtt: 220, jitter: 70, loss: 0.05 },
  { name: 'bursty', rtt: 80, jitter: 12, loss: 0.03, burst: 4 },
  { name: 'poor-lossless', rtt: 220, jitter: 70, loss: 0, control: true },
].map(Object.freeze));

/** 42.48's five independent-loss profiles. */
export const INDEPENDENT_PROFILES = NETWORK_PROFILES.filter(p => !p.burst && !p.control);

/** The profiles named in `list` (comma-separated), or every one but the controls when it is absent. */
export function chooseProfiles(list) {
  if (!list) return NETWORK_PROFILES.filter(p => !p.control);
  return list.split(',').map(name => NETWORK_PROFILES.find(p => p.name === name) ?? (() => { throw new Error(`Unknown profile ${name}`); })());
}
