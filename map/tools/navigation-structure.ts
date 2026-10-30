/** Read-only navigation evidence (#688). Definitions and limits: docs/51.10. */
import { composeRegions } from '../micro/compose.ts';
import { builtMapCollision, builtMapFrame } from '../micro/adapter.ts';
import { buildPortalGraph } from '../navigation.ts';
import { entry, freePaths, locate, mapFreeSpace, type FreeSpace } from '../../shared/free-space.ts';
import { navigationClearance, navigationMap } from '../../shared/map/navigation.ts';
import { bodyRadius, sweptClear } from '../../shared/movement.ts';
import { regionAt, type PortalGraph } from '../../shared/navigation/portal-graph.ts';
import { regionDomain } from '../../shared/navigation/mesh-level.ts';
import { bounds, clipPolygonToRect, rect, segmentShapeDistance, transform, type Shape } from '../../shared/shape.ts';
import type { Vec2 } from '../../shared/types.ts';
import type { ToolMap } from './core.ts';

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export interface RouteSample {
  category: string; stratum: string; from: Vec2; to: Vec2; fromRegion: number; toRegion: number;
  status: 'complete' | 'invalid-endpoint' | 'unreachable' | 'search-miss' | 'sweep-defect'; distance: number; length: number | null; ratio: number | null;
}
export function summarizeRoutes(records: readonly RouteSample[]) {
  const ratios = records.flatMap(r => r.ratio === null ? [] : [r.ratio]).sort((a, b) => a - b);
  const percentile = (p: number) => ratios.length ? ratios[Math.ceil(p * ratios.length) - 1]! : null;
  return { attempted: records.length, complete: ratios.length, median: percentile(.5), p90: percentile(.9),
    shareAbove1_5: ratios.length ? ratios.filter(r => r > 1.5).length / ratios.length : null,
    invalidEndpoints: records.filter(r => r.status === 'invalid-endpoint').length,
    unreachable: records.filter(r => r.status === 'unreachable').length,
    searchMisses: records.filter(r => r.status === 'search-miss').length,
    sweepDefects: records.filter(r => r.status === 'sweep-defect').length };
}

function triangle(space: FreeSpace, t: number): Vec2[] {
  return [0, 1, 2].map(k => { const v = space.triangles[t * 3 + k]!; return { x: space.points[v * 2]!, y: space.points[v * 2 + 1]! }; });
}
const centre = (points: Vec2[]) => ({ x: points.reduce((n, p) => n + p.x, 0) / points.length, y: points.reduce((n, p) => n + p.y, 0) / points.length });
const areaOf = ([a, b, c]: Vec2[]) => Math.abs((b!.x - a!.x) * (c!.y - a!.y) - (b!.y - a!.y) * (c!.x - a!.x)) / 2;

/** Split triangles at ownership cells: long triangles can span many different region types. */
function ownedAreas(space: FreeSpace, graph: PortalGraph, marked: Uint8Array) {
  const areas = graph.regions.map(() => ({ walkableArea: 0, deadEndArea: 0 })), size = graph.cellSize;
  for (let t = 0; t < space.triangles.length / 3; t++) {
    const points = triangle(space, t), xs = points.map(p => p.x), ys = points.map(p => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) / size)), x1 = Math.min(graph.cols - 1, Math.floor(Math.max(...xs) / size));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) / size)), y1 = Math.min(graph.rows - 1, Math.floor(Math.max(...ys) / size));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const owner = graph.owner[y * graph.cols + x]!; if (owner < 0) continue;
      const clipped = clipPolygonToRect(points, { x: x * size, y: y * size, w: size, h: size });
      let area = 0;
      for (let i = 0; i < clipped.length; i++) { const a = clipped[i]!, b = clipped[(i + 1) % clipped.length]!; area += a.x * b.y - b.x * a.y; }
      area = Math.abs(area) / 2;
      areas[owner]!.walkableArea += area; if (marked[t]) areas[owner]!.deadEndArea += area;
    }
  }
  return areas;
}

/** Bridge cuts, filtered by physical scale; union smaller sides so nested pockets never double count. */
export function measureMeshPockets(space: FreeSpace, minWidth: number, maxWidth: number, minArea: number) {
  const n = space.triangles.length / 3;
  const areas = Array.from({ length: n }, (_, t) => areaOf(triangle(space, t)));
  const centres = Array.from({ length: n }, (_, t) => centre(triangle(space, t)));
  const adjacent = Array.from({ length: n }, (_, t) => [0, 1, 2].flatMap(k => {
    const twin = space.twins[t * 3 + k]!; return twin < 0 ? [] : [{ to: Math.floor(twin / 3), edge: t * 3 + k }];
  }));
  const seen = new Int32Array(n).fill(-1), low = new Int32Array(n), parent = new Int32Array(n).fill(-1), componentOf = new Int32Array(n);
  const subtree = [...areas], order: number[] = [], bridges: { child: number; edge: number; root: number }[] = [];
  let clock = 0;
  // Iterative DFS avoids call-stack dependence on map size.
  for (let root = 0; root < n; root++) {
    if (seen[root] !== -1) continue;
    seen[root] = low[root] = clock++; order.push(root); componentOf[root] = root;
    const stack = [{ t: root, next: 0 }];
    while (stack.length) {
      const frame = stack.at(-1)!, edges = adjacent[frame.t]!;
      if (frame.next < edges.length) {
        const { to } = edges[frame.next++]!;
        if (to === parent[frame.t]) continue;
        if (seen[to] === -1) {
          parent[to] = frame.t; seen[to] = low[to] = clock++; order.push(to); componentOf[to] = root; stack.push({ t: to, next: 0 });
        } else low[frame.t] = Math.min(low[frame.t]!, seen[to]!);
      } else {
        stack.pop(); const p = parent[frame.t]!;
        if (p >= 0) {
          subtree[p]! += subtree[frame.t]!; low[p] = Math.min(low[p]!, low[frame.t]!);
          if (low[frame.t]! > seen[p]!) bridges.push({ child: frame.t, edge: adjacent[p]!.find(e => e.to === frame.t)!.edge, root });
        }
      }
    }
  }
  const ends = new Int32Array(n);
  // DFS descendants occupy a contiguous preorder interval.
  for (const t of [...order].reverse()) { ends[t] = Math.max(ends[t]!, seen[t]! + 1); const p = parent[t]!; if (p >= 0) ends[p] = Math.max(ends[p]!, ends[t]!); }
  const marked = new Uint8Array(n), pockets: { opening: Vec2[]; width: number; area: number; depth: number }[] = [];
  for (const { child, edge, root } of bridges) {
    const t = Math.floor(edge / 3), k = edge % 3, vertices = triangle(space, t);
    const opening = [vertices[k]!, vertices[(k + 1) % 3]!], width = distance(opening[0]!, opening[1]!);
    if (width < minWidth || width > maxWidth) continue;
    const smaller = subtree[child]! <= subtree[root]! / 2;
    const area = smaller ? subtree[child]! : subtree[root]! - subtree[child]!;
    if (area < Math.max(minArea, 2 * width * width)) continue;
    const members = order.slice(seen[root]!, ends[root]!).filter(v => (seen[v]! >= seen[child]! && seen[v]! < ends[child]!) === smaller);
    const mid = centre(opening), depth = members.reduce((d, v) => Math.max(d, distance(mid, centres[v]!)), 0);
    if (depth < 2 * width) continue;
    for (const v of members) marked[v] = 1;
    pockets.push({ opening, width, area, depth });
  }
  return { area: areas.reduce((a, v, i) => a + (marked[i] ? v : 0), 0), pockets, marked, areas, centres, componentOf,
    components: order.filter(t => parent[t] === -1).length };
}

/** Geometry only: claims, reserves, spots and decals never make an empty court nonempty. */
function structureShapes(map: ToolMap, origin: Vec2): Shape[] {
  return map.results.flatMap(r => r.elements.flatMap(e => {
    const x = e.x + origin.x, y = e.y + origin.y, template = e.template;
    const shapes: Shape[] = template.parts.flatMap(p => p.part === 'obstacle' ? [transform(p.shape, x, y)]
      : p.part === 'gate' ? [rect(x + p.x - p.w / 2, y + p.y - p.h / 2, p.w, p.h)] : []);
    if (template.encloses) shapes.push(rect(x, y, template.w, template.h));
    for (const roof of template.roofs ?? []) for (const cell of roof.cells) {
      const size = roof.cellSize ?? 40;
      shapes.push(rect(x + (roof.origin?.x ?? 0) + cell.x * size, y + (roof.origin?.y ?? 0) + cell.y * size, size, size));
    }
    return shapes;
  }));
}

export function measureNavigationStructure(map: ToolMap) {
  const built = composeRegions(map.results), collision = builtMapCollision(built), { origin } = builtMapFrame(built);
  const graph = buildPortalGraph(built, origin), size = built.cellSize, nav = navigationMap(collision, true);
  const structures = structureShapes(map, origin);
  const structureBuckets = new Map<string, Shape[]>();
  for (const shape of structures) {
    const b = bounds(shape);
    for (let y = Math.floor((b.y - size / 2) / size); y <= Math.floor((b.y + b.h + size / 2) / size); y++)
      for (let x = Math.floor((b.x - size / 2) / size); x <= Math.floor((b.x + b.w + size / 2) / size); x++) {
        const key = `${x},${y}`; if (!structureBuckets.has(key)) structureBuckets.set(key, []); structureBuckets.get(key)!.push(shape);
      }
  }
  const world = (p: Vec2) => ({ x: p.x + origin.x, y: p.y + origin.y });
  const regions = built.regions.map((r, index) => {
    const cells = new Set(r.brief.cells.map(c => `${c.x},${c.y}`));
    const perimeter = r.brief.cells.reduce((n, c) => n + [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => !cells.has(`${c.x + dx!},${c.y + dy!}`)).length, 0) * size;
    const passable = r.brief.portals.reduce((n, p) => n + p.length * size, 0);
    return { index, id: r.brief.id, type: r.brief.type, portals: r.brief.portals.length, perimeter, guaranteedPassableBoundary: passable,
      nonGuaranteedBoundaryShare: perimeter ? 1 - passable / perimeter : null };
  });
  const roles = (['contestant', 'gladiator'] as const).map(role => {
    const clearance = navigationClearance(role), radius = bodyRadius({ role });
    // Same eroded mesh and swept-path implementation as navigation; global domain removes representative-portal stretch.
    const space = mapFreeSpace(nav, 'navigation-structure whole map', [{ x: 0, y: 0, w: nav.width, h: nav.height }], clearance);
    const pockets = measureMeshPockets(space, size / 2, 2 * size, 4 * size * size);
    const ownershipAreas = ownedAreas(space, graph, pockets.marked);
    const samples: RouteSample[] = [];
    const stratum = (d: number) => d < 6 * size ? 'short:<6-cells' : d < 24 * size ? 'medium:6-24-cells' : 'long:>=24-cells';
    const pairs: { from: Vec2; to: Vec2; category: string }[] = [];
    const sites = built.regions.flatMap(r => r.coreElements.map(s => ({ ...world(s), kind: s.kind })));
    const spawns = sites.filter(s => s.kind === 'spawn' || s.kind === 'hunter-spawn');
    const chargers = sites.filter(s => s.kind === 'charger'), exits = sites.filter(s => s.kind === 'exit');
    for (const from of spawns) for (const to of [...exits, ...chargers]) pairs.push({ from, to, category: to.kind === 'exit' ? 'spawn-exit' : 'spawn-charger' });
    const loot = built.regions.flatMap(r => r.loot.map(world));
    const selectedLoot = loot.filter((_, i) => i % Math.max(1, Math.ceil(loot.length / 32)) === 0);
    for (const from of chargers) for (const to of selectedLoot) pairs.push({ from, to, category: 'charger-loot' });
    let globalIndex = 0;
    const pointsByRegion = built.regions.map(r => r.brief.cells.map((c, index) => ({
      p: world({ x: (c.x + .5) * size, y: (c.y + .5) * size }), index, globalIndex: globalIndex++,
    })).filter(({ p }) => locate(space, p) >= 0));
    // Fixed hash priority, no RNG and no geometry-dependent stream consumption.
    const priority = (i: number) => Math.imul(i + 1, 2654435761) >>> 0;
    const select = (points: { p: Vec2; index: number; globalIndex: number }[], limit: number, across = false) => points
      .map(v => ({ p: v.p, rank: priority(across ? v.globalIndex : v.index) })).sort((a, b) => a.rank - b.rank).slice(0, limit).map(v => v.p);
    const addPairs = (points: Vec2[], category: string, limit: number) => {
      const counts = new Map<string, number>();
      const candidates: { i: number; j: number; rank: number }[] = [];
      for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
        if (category === 'across-map' && regionAt(graph, points[i]!) === regionAt(graph, points[j]!)) continue;
        candidates.push({ i, j, rank: priority(i * points.length + j) });
      }
      // Rank pairs as well as endpoints so a stratum does not take every route from its first point.
      for (const { i, j } of candidates.sort((a, b) => a.rank - b.rank)) {
        const key = stratum(distance(points[i]!, points[j]!));
        if ((counts.get(key) ?? 0) >= limit) continue;
        pairs.push({ from: points[i]!, to: points[j]!, category }); counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    };
    for (const points of pointsByRegion) addPairs(select(points, 16), 'within-region', 3);
    addPairs(select(pointsByRegion.flat(), 96, true), 'across-map', 24);
    const components = new WeakMap<FreeSpace, Int32Array>([[space, pockets.componentOf]]);
    const componentLabels = (mesh: FreeSpace) => {
      const cached = components.get(mesh); if (cached) return cached;
      const labels = new Int32Array(mesh.triangles.length / 3).fill(-1);
      for (let root = 0; root < labels.length; root++) {
        if (labels[root] !== -1) continue;
        labels[root] = root; const pending = [root];
        while (pending.length) {
          const t = pending.pop()!;
          for (let k = 0; k < 3; k++) {
            const edge = mesh.twins[t * 3 + k]!; if (edge < 0) continue;
            const to = Math.floor(edge / 3); if (labels[to] !== -1) continue;
            labels[to] = root; pending.push(to);
          }
        }
      }
      components.set(mesh, labels); return labels;
    };
    const grouped = new Map<string, typeof pairs>();
    for (const pair of pairs) { const key = `${pair.category === 'within-region' ? regionAt(graph, pair.from) : 'global'}/${pair.from.x},${pair.from.y}`; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key)!.push(pair); }
    for (const group of grouped.values()) {
      const from = group[0]!.from;
      const region = regionAt(graph, from);
      const searchSpace = group[0]!.category === 'within-region'
        ? mapFreeSpace(nav, `navigation-structure region ${region}`, regionDomain(graph, region), clearance) : space;
      const paths = freePaths(searchSpace, from, group.map(p => p.to), clearance + 1);
      group.forEach((p, i) => {
        const direct = distance(from, p.to); if (direct === 0) return;
        const path = paths[i]; let status: RouteSample['status'] = 'complete';
        if (!sweptClear(nav, from, from, radius) || !sweptClear(nav, p.to, p.to, radius)) status = 'invalid-endpoint';
        else if (!path) {
          const a = entry(searchSpace, from, clearance + 1), b = entry(searchSpace, p.to, clearance + 1), labels = componentLabels(searchSpace);
          status = a && b && labels[a.triangle] !== labels[b.triangle] ? 'unreachable' : 'search-miss';
        }
        else for (let k = 0; k < path.points.length - 1; k++) {
          const r = Math.min(clearance, k === 0 && path.leads[0] ? radius : clearance, k === path.points.length - 2 && path.leads[1] ? radius : clearance);
          if (!sweptClear(nav, path.points[k]!, path.points[k + 1]!, r)) { status = 'sweep-defect'; break; }
        }
        samples.push({ category: p.category, stratum: stratum(direct), from, to: p.to, fromRegion: regionAt(graph, from), toRegion: regionAt(graph, p.to), status,
          distance: direct, length: status === 'complete' ? path!.length : null, ratio: status === 'complete' ? path!.length / direct : null });
      });
    }
    const perRegion = regions.map(region => {
      let walkableSamples = 0, emptySamples = 0, boundarySamples = 0, blockedBoundarySamples = 0;
      for (const cell of built.regions[region.index]!.brief.cells) for (const dx of [.25, .75]) for (const dy of [.25, .75]) {
        const p = world({ x: (cell.x + dx) * size, y: (cell.y + dy) * size });
        if (locate(space, p) < 0) continue;
        walkableSamples++;
        const nearby = structureBuckets.get(`${Math.floor(p.x / size)},${Math.floor(p.y / size)}`) ?? [];
        if (!nearby.some(s => segmentShapeDistance(p, p, s) <= size / 2)) emptySamples++;
      }
      const cells = new Set(built.regions[region.index]!.brief.cells.map(c => `${c.x},${c.y}`));
      for (const c of built.regions[region.index]!.brief.cells) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (cells.has(`${c.x + dx!},${c.y + dy!}`)) continue;
        for (const offset of [-.25, .25]) {
          const p = world({ x: (c.x + .5 + dx! * .5 + (dy ? offset : 0)) * size, y: (c.y + .5 + dy! * .5 + (dx ? offset : 0)) * size });
          const a = { x: p.x - dx! * size / 4, y: p.y - dy! * size / 4 }, b = { x: p.x + dx! * size / 4, y: p.y + dy! * size / 4 };
          boundarySamples++; if (!sweptClear(nav, a, b, clearance)) blockedBoundarySamples++;
        }
      }
      const { walkableArea, deadEndArea } = ownershipAreas[region.index]!;
      return { ...region, walkableArea, deadEndArea, deadEndShare: walkableArea ? deadEndArea / walkableArea : null,
        walkableSamples, emptySamples, emptyAreaEstimate: emptySamples * size * size / 4, emptyShare: walkableSamples ? emptySamples / walkableSamples : null,
        boundarySamples, blockedBoundarySamples, impassableBoundaryShare: boundarySamples ? blockedBoundarySamples / boundarySamples : null };
    });
    const summary = (records: RouteSample[]) => {
      const keys = [...new Set(records.map(s => `${s.category}/${s.stratum}`))].sort();
      return Object.fromEntries(keys.map(key => [key, summarizeRoutes(records.filter(s => `${s.category}/${s.stratum}` === key))]));
    };
    const breakdown = (key: 'type' | 'portals') => Object.fromEntries([...new Set(regions.map(r => String(r[key])))].sort().map(value => {
      const members = perRegion.filter(r => String(r[key]) === value), ids = new Set(members.map(r => r.index));
      const sum = (field: 'walkableSamples' | 'emptySamples' | 'perimeter' | 'guaranteedPassableBoundary') => members.reduce((n, r) => n + r[field], 0);
      return [value, { regions: members.length, onePortalShare: members.filter(r => r.portals === 1).length / members.length,
        portalCounts: members.map(r => r.portals), perimeter: sum('perimeter'), guaranteedPassableBoundary: sum('guaranteedPassableBoundary'),
        walkableSamples: sum('walkableSamples'), emptySamples: sum('emptySamples'),
        walkableArea: members.reduce((n, r) => n + r.walkableArea, 0), deadEndArea: members.reduce((n, r) => n + r.deadEndArea, 0),
        emptyAreaEstimate: members.reduce((n, r) => n + r.emptyAreaEstimate, 0),
        boundarySamples: members.reduce((n, r) => n + r.boundarySamples, 0), blockedBoundarySamples: members.reduce((n, r) => n + r.blockedBoundarySamples, 0),
        detourByOrigin: summary(samples.filter(s => ids.has(s.fromRegion))), detourByDestination: summary(samples.filter(s => ids.has(s.toRegion))) }];
    }));
    return { body: role === 'gladiator' ? 'hunter' : role, clearance, collisionRadius: radius, detour: summary(samples), samples,
      walkableArea: pockets.areas.reduce((a, b) => a + b, 0), deadEndArea: pockets.area, pocketCuts: pockets.pockets, components: pockets.components,
      regions: perRegion, byType: breakdown('type'), byPortalCount: breakdown('portals'),
      sampling: { lootAvailable: loot.length, lootSelected: selectedLoot.length, cellCentresAvailable: pointsByRegion.reduce((n, p) => n + p.length, 0) } };
  });
  return { version: 'navigation-structure-1', seed: map.layout.seed, params: map.layout.params, cellSize: size, doors: 'openable',
    definitions: 'docs/51.10-measurement.md', regions: regions.length, portals: graph.portals.length,
    onePortalShare: regions.filter(r => r.portals === 1).length / regions.length, roles };
}
