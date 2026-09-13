import { createGenerationContext } from './context.ts';
import { buildTopology } from './topology.ts';
import { buildTerrain } from './terrain.ts';
import { buildStructures } from './structures.ts';
import { buildObjectives } from './objectives.ts';
import type { GameMap } from '../types.ts';

export function generateMap(seed: number): GameMap {
  const context = createGenerationContext(seed);
  // Ordered stages share the same RNG and ID stream. This order defines seeded output.
  buildTopology(context);
  buildTerrain(context);
  buildStructures(context);
  buildObjectives(context);
  return context.map;
}
