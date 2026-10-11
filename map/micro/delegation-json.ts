/** Stable comparison for owning delegation data; never silently lose values to JSON. */
export function delegationJSON(value: unknown): string {
  function canonical(at: unknown): unknown {
    if (at === null || typeof at === 'string' || typeof at === 'boolean') return at;
    if (typeof at === 'number' && Number.isFinite(at)) return at;
    if (Array.isArray(at)) return at.map(canonical);
    if (at && typeof at === 'object' && Object.getPrototypeOf(at) === Object.prototype)
      return Object.fromEntries(Object.entries(at).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    throw new Error('Delegation snapshots need finite JSON values.');
  }
  return JSON.stringify(canonical(value));
}

export const sameDelegationJSON = (a: unknown, b: unknown): boolean => delegationJSON(a) === delegationJSON(b);
