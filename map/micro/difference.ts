/**
 * Where a rebuilt region first differs from a stored one, for the tools that rebuild a
 * region from its brief and compare (the Map Lab's drill-down, the micro lab's import, 20.5).
 * Plain values compare by structure: key order doesn't matter, and a key holding
 * `undefined` equals a missing one, as after a JSON round trip.
 */
export function firstDifference(a: unknown, b: unknown, at = 'result'): string | null {
  // A JSON round trip reads -0 as 0, so numbers compare with ===.
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b))
    return `${at}: ${JSON.stringify(a)?.slice(0, 60)} rebuilt, ${JSON.stringify(b)?.slice(0, 60)} stored`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const found = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], Array.isArray(a) ? `${at}[${key}]` : `${at}.${key}`);
    if (found) return found;
  }
  return null;
}
