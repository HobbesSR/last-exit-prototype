/**
 * What a map looks like once it has been through an artifact: the same map
 * without the metrics that count what the generator run did (`RUN_METRICS`),
 * because those aren't stored and can't be measured on the map.
 */
import { RUN_METRICS } from "../src/core.ts";
import type { GeneratedMap } from "../src/types.ts";

export function asRead(map: GeneratedMap): GeneratedMap {
  const metrics = { ...map.metrics };
  for (const name of RUN_METRICS) delete metrics[name];
  return { ...map, metrics };
}
