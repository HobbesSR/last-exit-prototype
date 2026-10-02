/**
 * The finished map (51 "What the finished map is", build step 9): a container holding the
 * Layout, the region results and the library, and one accessor for every view. Nothing a
 * view computes is copied into the map, so a tool reads the resolved layout, the proof or
 * the report through `mapViews`, never through a field.
 *
 * Macro can't build or compose regions (50), so the game lends both as `MapEngines`.
 */
import { briefs, chainZones } from "./briefs.ts";
import { declaredGrid } from "./declared-grid.ts";
import type { ChainLibrary } from "./library.ts";
import { measurement } from "./measurement.ts";
import { placement } from "./placement.ts";
import { proof } from "./proof.ts";
import { regions } from "./regions.ts";
import { resolution } from "./resolution.ts";
import type {
  BuiltMap, ChainMap, ChainParams, DeclaredGrid, LayoutRegions, MapEngines, ReachabilityProof, RegionBrief, Report, ResolvedLayout, Zone,
} from "./types.ts";

/**
 * The version of macro's stages, placement through briefs. A change to what any of them gives
 * a saved Layout bumps it, and a save from another version is refused by name (`saving.ts`).
 */
export const MACRO_VERSION = 1;

/** Places a layout, then builds every brief with the game's strategies. */
export function generateChainMap<Element>(
  seed: string, params: ChainParams, library: ChainLibrary, cellSize: number, engines: MapEngines<Element>,
): ChainMap<Element> {
  const map: ChainMap<Element> = { layout: placement(seed, params, library), library, cellSize, build: engines.version, results: [] };
  map.results = mapViews(map).briefs.map((brief) => engines.build(brief));
  return map;
}

/** Every stage output other than the two objects, each computed on first read. */
export interface MapViews<Element = unknown> {
  readonly declaredGrid: DeclaredGrid;
  readonly resolved: ResolvedLayout;
  readonly regions: LayoutRegions;
  readonly proof: ReachabilityProof;
  readonly zones: Zone[];
  readonly briefs: RegionBrief[];
  readonly built: BuiltMap<Element>;
  readonly report: Report;
}

/**
 * The one accessor (51 "What the finished map is"). Views are recomputed from the map's
 * objects, never stored, and each is computed once per accessor. `compose` is the game's,
 * needed only for the built map and the report.
 */
export function mapViews<Element>(map: ChainMap<Element>, compose?: MapEngines<Element>["compose"]): MapViews<Element> {
  const { layout, library } = map;
  const cache = new Map<keyof MapViews, unknown>();
  const once = <K extends keyof MapViews<Element>>(key: K, make: () => MapViews<Element>[K]): MapViews<Element>[K] => {
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key) as MapViews<Element>[K];
  };
  const views: MapViews<Element> = {
    get declaredGrid() { return once("declaredGrid", () => declaredGrid(layout, library)); },
    get resolved() { return once("resolved", () => resolution(layout, library)); },
    get regions() { return once("regions", () => regions(views.resolved, layout.seed)); },
    get proof() { return once("proof", () => proof(views.regions)); },
    get zones() { return once("zones", () => chainZones(layout.params)); },
    get briefs() { return once("briefs", () => briefs(layout, views.regions, views.zones, library, map.cellSize)); },
    get built() {
      return once("built", () => {
        if (!compose) throw new Error("the built map needs the game's compose; pass it to mapViews");
        return compose(map.results);
      });
    },
    get report() { return once("report", () => measurement(views.built, views.proof, layout, library)); },
  };
  return views;
}
