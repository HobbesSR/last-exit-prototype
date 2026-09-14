import { BLOCK_SIZE } from './world.ts';
import { distance } from './context.ts';
import { placeElement } from './element.ts';
import { REGION_ELEMENTS, REGION_PROPS } from './templates.ts';
import type { GenerationContext, SpawnedGenerationContext } from './context.ts';
import type { Box, ModuleKind, World } from '../types.ts';

const HALF_BLOCK = BLOCK_SIZE / 2, INSET = 110, CENTRE_RESERVE = 110;
// The margin `clearFootprint` applies to reservations; see `map/context.ts`.
const RESERVE_MARGIN = 10;

/**
 * The largest a corner element may be in one axis and still clear the block centre reserved for the
 * through-route. A template must satisfy it in at least one axis: fail both and `clearFootprint`
 * rejects the element at every corner of every block, so it silently never appears on any map rather
 * than failing loudly. `tests/element.test.js` holds the catalogue to it.
 */
export const CORNER_CLEARANCE = HALF_BLOCK - INSET - CENTRE_RESERVE - RESERVE_MARGIN;

/** Places spawn points, one structural element per eligible block corner, and street props. */
export function buildStructures(context: GenerationContext): asserts context is SpawnedGenerationContext {
  const { map, entryNode, exitNode, lookup, reserve, clearFootprint, spots, range, rect } = context;
  for (const n of map.nodes) reserve(n.x, n.y, CENTRE_RESERVE);
  reserve(entryNode.x, entryNode.y, 490); reserve(exitNode.x, exitNode.y, 300);
  // Spread contestants across four nearby connected blocks, rather than a single firing line.
  const startBlocks = [entryNode];
  for (let i = 0; i < startBlocks.length && startBlocks.length < 4; i++) for (const id of startBlocks[i].neighbors) {
    const n = lookup.get(id)!;
    if (!startBlocks.includes(n)) startBlocks.push(n);
    if (startBlocks.length === 4) break;
  }
  map.spawns = startBlocks.flatMap(n => [-200, 200].map(dy => ({ x: n.x - 100, y: n.y + dy })));
  for (const p of map.spawns) reserve(p.x, p.y, 165);
  for (const st of map.streets) {
    // Keep all center-to-port approaches free of props and building footprints.
    for (const a of [st.a, st.b]) {
      const steps = Math.ceil(distance(a, st.port) / 80);
      for (let i = 0; i <= steps; i++) reserve(a.x + (st.port.x - a.x) * i / steps, a.y + (st.port.y - a.y) * i / steps, 85);
    }
  }
  for (const [index, n] of map.nodes.entries()) {
    const kind = ['yard', 'depot', 'garden'][range(0, 2)] as ModuleKind;
    const module = { id: index, x: n.x, y: n.y, width: BLOCK_SIZE, height: BLOCK_SIZE, kind }; map.modules.push(module);
    const set = REGION_ELEMENTS[kind], template = set[range(0, set.length - 1)];
    // A corner sits a fixed inset from the block edge, so a larger element grows inward, away from
    // the boundary wall and the reserved centre the through-route crosses.
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    const corner = ([sx, sy]: number[], w: World, h: World): Box =>
      ({ x: n.x + (sx < 0 ? INSET - HALF_BLOCK : HALF_BLOCK - INSET - w), y: n.y + (sy < 0 ? INSET - HALF_BLOCK : HALF_BLOCK - INSET - h), w, h });
    // The structure gets first refusal on its assigned corner, then the others: an element wider than
    // the 250 a prop occupies would otherwise simply be lost whenever that one corner is crowded,
    // and blocks with no building are blocks with no indoor loot.
    let structural = -1;
    if (index % 2 === 0) for (let k = 0; k < corners.length; k++) {
      const box = corner(corners[(index + k) % corners.length], template.w, template.h);
      if (!clearFootprint(box)) continue;
      placeElement(context, template, box.x, box.y, { nodeId: n.id, locked: index % 10 === 0 });
      structural = (index + k) % corners.length; break;
    }
    const cover = REGION_PROPS[kind];
    for (const [i, spec] of corners.entries()) {
      if (i === structural) continue;
      const box = corner(spec, 250, 250);
      if (!clearFootprint(box)) continue;
      // Every third corner gets the region's cover arrangement rather than a lone box, so what sits
      // between the structures tells you which kind of block you are in too.
      if ((index + i) % 3 === 0) {
        const patch = corner(spec, cover.w, cover.h);
        if (clearFootprint(patch)) { placeElement(context, cover, patch.x, patch.y, { nodeId: n.id }); continue; }
      }
      const prop = { x: box.x + range(0, 90), y: box.y + range(0, 90), w: range(65, 140), h: range(65, 140) };
      if (clearFootprint(prop)) rect(prop.x, prop.y, prop.w, prop.h, kind === 'depot' ? 'container' : 'crate', { color: index % 3 });
    }
    // Loot courtyard is in a different quarter than the through-route center.
    spots.push({ x: n.x + 220, y: n.y - 220, nodeId: n.id });
  }
}
