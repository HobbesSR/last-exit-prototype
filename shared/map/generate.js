import { createGenerationContext } from './context.js';
import { buildTopology } from './topology.js';
import { buildTerrain } from './terrain.js';
import { buildStructures } from './structures.js';
import { buildObjectives } from './objectives.js';

export function generateMap(seed) {
  const context = createGenerationContext(seed);
  // Ordered stages share the same RNG and ID stream. This order defines seeded output.
  buildTopology(context);
  buildTerrain(context);
  buildStructures(context);
  buildObjectives(context);
  return context.map;
}
