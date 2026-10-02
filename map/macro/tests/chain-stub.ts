/**
 * Stand-ins for the game's engines in macro's tests. Macro can't build or compose regions
 * (50), so these do the least that keeps every promise: the builder sites what its brief
 * asks, and the composer orders what it's given the way the game's `composeRegions` does.
 */
import { CORE_ELEMENT_KINDS } from "../../kernel/contract.ts";
import type { BuiltMap, CoreElementSite, PortalPair, RegionBrief, RegionResult } from "../../kernel/contract.ts";
import type { MapEngines } from "../src/chain/types.ts";

/** A builder that sites what its brief asks, one site per cell centre in cell order, and nothing else. */
export function stubBuild(brief: RegionBrief): RegionResult {
  const coreElements: CoreElementSite[] = [];
  for (const kind of CORE_ELEMENT_KINDS) for (let i = 0; i < (brief.coreElements?.[kind] ?? 0); i++) {
    const cell = brief.cells[coreElements.length % brief.cells.length]!;
    coreElements.push({ kind, x: (cell.x + 0.5) * brief.cellSize, y: (cell.y + 0.5) * brief.cellSize });
  }
  return { version: "region-2", brief, elements: [], coreElements, loot: [], manifest: {} };
}

/** What the game's `composeRegions` returns for agreeing results: regions in id order, one pair per shared portal. */
export function stubCompose(results: readonly RegionResult[]): BuiltMap {
  const sorted = [...results].sort((p, q) => p.brief.id < q.brief.id ? -1 : p.brief.id > q.brief.id ? 1 : 0);
  const holders = new Map<string, string[]>();
  for (const { brief } of sorted) for (const portal of brief.portals) holders.set(portal.id, [...holders.get(portal.id) ?? [], brief.id]);
  const pairs: PortalPair[] = [...holders].map(([portal, [a, b]]) => ({ portal, a: a!, b: b! }))
    .sort((p, q) => p.portal < q.portal ? -1 : 1);
  return { cellSize: sorted[0]!.brief.cellSize, regions: sorted, pairs };
}

export const STUB_ENGINES: MapEngines = { version: "stub-1", build: stubBuild, compose: stubCompose };
