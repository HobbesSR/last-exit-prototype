/**
 * Proof (51 stage 4), a view: the components of the region graph, from a union-find over
 * the regions its portals join. It is macro's link in the chain of inference (51
 * principle 8), a claim about guarantees and not geometry, and it names no core element
 * regions: which region holds a core element isn't known before micro.
 */
import type { ChainLibrary } from "./library.ts";
import type { LayoutRegions, MacroStages, ReachabilityProof } from "./types.ts";

export const proof: MacroStages["proof"] = (layoutRegions) => {
  const index = new Map(layoutRegions.regions.map((region, i) => [region.id, i]));
  const parent = layoutRegions.regions.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  for (const { a, b } of layoutRegions.graph) {
    const [ra, rb] = [root(index.get(a)!), root(index.get(b)!)];
    // The lower root wins, so each component is keyed by its first region.
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  // Components in order of their first region, and regions in their own order within each.
  const byRoot = new Map<number, string[]>();
  layoutRegions.regions.forEach((region, i) => {
    const r = root(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r)!.push(region.id);
  });
  return { components: [...byRoot.values()] };
};

/**
 * Why a proof doesn't hold (17 M2's assumption): every layout region must be in the spawn
 * region's component. A region is a spawn region when its class promises a `spawn`
 * core element. With none, as in playground mode, the largest component stands in for it. One
 * message per component left out, naming its regions.
 */
export function proofViolations(reachability: ReachabilityProof, layoutRegions: LayoutRegions, library: ChainLibrary): string[] {
  const spawnClasses = new Set(Object.entries(library.cellClasses)
    .filter(([, cellClass]) => cellClass.coreElements?.spawn !== undefined).map(([id]) => id));
  const spawn = layoutRegions.regions.find((region) => spawnClasses.has(region.class));
  return unprovenComponents(reachability, spawn?.id).map(({ message }) => message);
}

/**
 * The rule `proofViolations` states, for a caller that knows the spawn region by other
 * means, such as the report from a brief's core elements. Every component but the spawn
 * region's is left out; with no spawn region, or one the proof doesn't name, every
 * component but the largest.
 */
export function unprovenComponents(reachability: ReachabilityProof, spawnRegion: string | undefined): { regions: string[]; message: string }[] {
  const { components } = reachability;
  if (components.length < 2) return [];
  const spawn = spawnRegion === undefined ? undefined : components.find((component) => component.includes(spawnRegion));
  const main = spawn ?? components.reduce((best, component) => component.length > best.length ? component : best);
  const anchor = spawn ? `spawn region ${spawnRegion}` : `the largest component, from ${main[0]}`;
  return components.filter((component) => component !== main).map((regions) => ({ regions,
    message: `${regions.length === 1 ? "region" : "regions"} ${regions.join(", ")} ${regions.length === 1 ? "has" : "have"} `
      + `no portal path to ${anchor}` }));
}
