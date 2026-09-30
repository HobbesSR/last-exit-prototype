/**
 * The micro surface, and the one place the catalogue is populated.
 *
 * Which builder owns a region is library data -- a class rule names one by id --
 * so the code's only job is to make the names resolvable. Importing this module
 * is what does that; importing it twice does it again with the same result,
 * because registration is by id and replaces rather than appends.
 *
 * Everything a caller needs is re-exported here, so a consumer imports
 * `src/micro/index.ts` and never has to know which file inside answers which
 * question.
 */
export * from "./types.ts";
export * from "./scale.ts";
export * from "./catalogue.ts";
export * from "./mask.ts";
export * from "./rng.ts";
export * from "./edit.ts";
export * from "./clearance.ts";

import { registerBuilder, setFallbackBuilder } from "./catalogue.ts";
import type { RegionBuilder } from "./types.ts";
import { scatterBuilder } from "./builders/scatter.ts";
import { openFieldBuilder } from "./builders/openField.ts";
import { compoundBuilder } from "./builders/compound.ts";
import { pillarHallBuilder } from "./builders/pillarHall.ts";
import { rubbleBuilder } from "./builders/rubble.ts";
import { courtyardBuilder } from "./builders/courtyard.ts";

export { scatterBuilder, scatterInput } from "./builders/scatter.ts";
export {
  PROP_MARGIN,
  approachCells,
  keepClear,
  standableSlot,
} from "./placement.ts";
export { openFieldBuilder, planClusters } from "./builders/openField.ts";
export type { ClusterPlan } from "./builders/openField.ts";
export {
  boxesApart,
  compoundBuilder,
  runAperture,
  siteRooms,
  wallStrip,
} from "./builders/compound.ts";
export type { SitedRoom } from "./builders/compound.ts";
export { pillarHallBuilder, planPillars } from "./builders/pillarHall.ts";
export type { PillarPlan } from "./builders/pillarHall.ts";
export { rubbleBuilder } from "./builders/rubble.ts";
export { courtyardBuilder, openingRuns } from "./builders/courtyard.ts";

/**
 * The catalogue as data, so tooling can list what exists without importing six
 * modules to find out. Ordered as the design reads: the fallback, then open
 * ground, then the structures.
 */
export const MICRO_BUILDERS: readonly RegionBuilder[] = Object.freeze([
  scatterBuilder,
  openFieldBuilder,
  pillarHallBuilder,
  rubbleBuilder,
  compoundBuilder,
  courtyardBuilder,
]);

/** The id every region falls back to: the treatment any area at all can take. */
export const FALLBACK_BUILDER_ID = scatterBuilder.id;

/**
 * Populate the catalogue. Idempotent by construction -- a builder is registered
 * under its id, so a second call replaces the same six entries with themselves --
 * and exported so a test that cleared the catalogue can put it back without
 * reaching for the module loader.
 */
export function registerMicroBuilders(): void {
  for (const builder of MICRO_BUILDERS) registerBuilder(builder);
  setFallbackBuilder(FALLBACK_BUILDER_ID);
}

registerMicroBuilders();
