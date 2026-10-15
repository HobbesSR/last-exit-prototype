// Experimental full-knowledge HPA-style query. This never changes the baked graph.
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

class Heap {
  items = [];
  push(item) {
    const a = this.items; let i = a.length; a.push(item);
    while (i) { const p = (i - 1) >> 1; if (cmp(a[p], item) <= 0) break; a[i] = a[p]; i = p; }
    a[i] = item;
  }
  pop() {
    const a = this.items, first = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      while (2 * i + 1 < a.length) {
        let c = 2 * i + 1;
        if (c + 1 < a.length && cmp(a[c + 1], a[c]) < 0) c++;
        if (cmp(last, a[c]) <= 0) break;
        a[i] = a[c]; i = c;
      }
      a[i] = last;
    }
    return first;
  }
  get length() { return this.items.length; }
  peek() { return this.items[0]; }
}
const cmp = (a, b) => a.cost - b.cost || a.id - b.id;

function chunkOf(graph, id) {
  const p = graph.point(id);
  return Math.floor(p.y / graph.chunkSize) * graph.chunkCols + Math.floor(p.x / graph.chunkSize);
}

function connectors(graph, p) {
  const range = graph.spacing * 2, result = new Map();
  const xmin = Math.max(0, Math.ceil((p.x - range) / graph.spacing - 0.5));
  const xmax = Math.min(graph.cols - 1, Math.floor((p.x + range) / graph.spacing - 0.5));
  const ymin = Math.max(0, Math.ceil((p.y - range) / graph.spacing - 0.5));
  const ymax = Math.min(graph.rows - 1, Math.floor((p.y + range) / graph.spacing - 0.5));
  for (let y = ymin; y <= ymax; y++) for (let x = xmin; x <= xmax; x++) {
    const id = y * graph.cols + x;
    if (!graph.passable[id]) continue;
    const q = graph.point(id), cost = distance(p, q);
    if (cost <= range && graph.clear(p, q)) result.set(id, cost);
  }
  return result;
}

function localSearch(hierarchy, chunk, starts, withPath = false) {
  const { graph } = hierarchy, cost = new Map(), prev = withPath ? new Map() : null, heap = new Heap();
  for (const [id, value] of starts) {
    if (chunkOf(graph, id) !== chunk || value >= (cost.get(id) ?? Infinity)) continue;
    cost.set(id, value); heap.push({ id, cost: value });
  }
  let expansions = 0;
  while (heap.length) {
    const current = heap.pop();
    if (current.cost !== cost.get(current.id)) continue;
    expansions++;
    const x = current.id % graph.cols, y = Math.floor(current.id / graph.cols);
    for (let d = 0; d < 8; d++) {
      if (!(graph.edges[current.id] & (1 << d))) continue;
      const id = (y + DY[d]) * graph.cols + x + DX[d];
      if (chunkOf(graph, id) !== chunk) continue;
      const next = current.cost + (d & 1 ? Math.SQRT2 : 1) * graph.spacing;
      if (next >= (cost.get(id) ?? Infinity)) continue;
      cost.set(id, next); if (prev) prev.set(id, current.id);
      heap.push({ id, cost: next });
    }
  }
  hierarchy.localSearches++;
  hierarchy.localExpansions += expansions;
  return { cost, prev, expansions };
}

function witness(hierarchy, chunk, starts, goal) {
  const search = localSearch(hierarchy, chunk, starts, true);
  if (!search.cost.has(goal)) return null;
  const ids = [];
  for (let id = goal; id !== undefined; id = search.prev.get(id)) ids.push(id);
  ids.reverse();
  return ids;
}

function bestGoal(costs, target) {
  let best = Infinity, id = -1;
  for (const [candidate, cost] of target) {
    const total = cost + (costs.get(candidate) ?? Infinity);
    if (total < best) { best = total; id = candidate; }
  }
  return { cost: best, id };
}

/** Build only boundary node lists; transfer rows are filled by the first query that needs them. */
export function createHierarchy(graph) {
  const boundary = new Map(), crossings = new Map(), rows = new Map();
  let crossingArcs = 0;
  for (let id = 0; id < graph.passable.length; id++) {
    if (!graph.passable[id]) continue;
    const chunk = chunkOf(graph, id);
    const x = id % graph.cols, y = Math.floor(id / graph.cols);
    for (let d = 0; d < 8; d++) {
      if (!(graph.edges[id] & (1 << d))) continue;
      const next = (y + DY[d]) * graph.cols + x + DX[d];
      if (chunkOf(graph, next) === chunk) continue;
      if (!boundary.has(chunk)) boundary.set(chunk, new Set());
      boundary.get(chunk).add(id);
      if (!crossings.has(id)) crossings.set(id, []);
      crossings.get(id).push({ id: next, cost: (d & 1 ? Math.SQRT2 : 1) * graph.spacing });
      crossingArcs++;
    }
  }
  for (const [chunk, ids] of boundary) boundary.set(chunk, [...ids].sort((a, b) => a - b));
  const boundaryNodes = [...boundary.values()].reduce((count, ids) => count + ids.length, 0);
  return {
    graph, boundary, crossings, rows, localSearches: 0, localExpansions: 0, cacheHits: 0,
    crossingCount: crossingArcs / 2,
    // Serialized scalar payload estimates, excluding JavaScript Map/Array overhead.
    boundaryIndexBytes: 4 * boundaryNodes + 12 * crossingArcs,
    get cacheBytes() { let bytes = 0; for (const costs of rows.values()) bytes += 4 + 12 * costs.size; return bytes; },
    stats() { return { cacheBytes: this.cacheBytes, boundaryIndexBytes: this.boundaryIndexBytes,
      crossingCount: this.crossingCount, cachedRows: rows.size,
      localSearches: this.localSearches, localExpansions: this.localExpansions, cacheHits: this.cacheHits }; },
    query(from, to, options) { return queryHierarchy(this, from, to, options); },
    transfer(id) {
      if (rows.has(id)) { this.cacheHits++; return rows.get(id); }
      const chunk = chunkOf(graph, id), search = localSearch(this, chunk, new Map([[id, 0]]));
      const costs = new Map();
      for (const target of boundary.get(chunk) ?? []) if (target !== id && search.cost.has(target)) costs.set(target, search.cost.get(target));
      rows.set(id, costs);
      return costs;
    },
  };
}

/** Full-knowledge coarse A*; `length` is sampled-graph exact, not continuous optimum. */
export function queryHierarchy(hierarchy, from, to, { direct = true, heuristic = true } = {}) {
  const { graph } = hierarchy;
  const stats = () => ({ localSearches: hierarchy.localSearches - beforeSearches,
    localExpansions: hierarchy.localExpansions - beforeExpansions,
    cacheHits: hierarchy.cacheHits - beforeHits, cacheBytes: hierarchy.cacheBytes,
    boundaryIndexBytes: hierarchy.boundaryIndexBytes, crossingCount: hierarchy.crossingCount });
  const beforeSearches = hierarchy.localSearches, beforeExpansions = hierarchy.localExpansions,
    beforeHits = hierarchy.cacheHits;
  const invalid = p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y) || !graph.clear(p, p);
  if (invalid(from) || invalid(to)) return { status: 'invalid-endpoint', length: Infinity, expansions: 0, path: [], ...stats() };
  if (direct && graph.clear(from, to)) return { status: 'complete', length: distance(from, to), expansions: 0, path: [from, to], ...stats() };
  const starts = connectors(graph, from), ends = connectors(graph, to);
  if (!starts.size || !ends.size) return { status: 'no-known-route', length: Infinity, expansions: 0, path: [], ...stats() };
  const source = new Map(), target = new Map(), sourceByChunk = new Map(), targetByChunk = new Map();
  for (const [id, cost] of starts) {
    const chunk = chunkOf(graph, id); if (!sourceByChunk.has(chunk)) sourceByChunk.set(chunk, new Map());
    sourceByChunk.get(chunk).set(id, cost);
  }
  for (const [id, cost] of ends) {
    const chunk = chunkOf(graph, id); if (!targetByChunk.has(chunk)) targetByChunk.set(chunk, new Map());
    targetByChunk.get(chunk).set(id, cost);
  }
  let best = Infinity, goal = -1, same = null;
  for (const [chunk, seeds] of sourceByChunk) {
    const search = localSearch(hierarchy, chunk, seeds);
    for (const id of hierarchy.boundary.get(chunk) ?? []) if (search.cost.has(id)) source.set(id, search.cost.get(id));
    if (targetByChunk.has(chunk)) {
      const candidate = bestGoal(search.cost, targetByChunk.get(chunk));
      if (candidate.cost < best) { best = candidate.cost; goal = -1; same = { chunk, id: candidate.id }; }
    }
  }
  for (const [chunk, seeds] of targetByChunk) {
    const search = localSearch(hierarchy, chunk, seeds);
    for (const id of hierarchy.boundary.get(chunk) ?? []) if (search.cost.has(id)) target.set(id, search.cost.get(id));
  }
  const costs = new Map(), prev = new Map(), heap = new Heap(), closed = new Set();
  const h = id => heuristic ? distance(graph.point(id), to) : 0;
  for (const [id, cost] of source) { costs.set(id, cost); heap.push({ id, cost: cost + h(id), g: cost }); }
  let expansions = 0;
  while (heap.length) {
    const current = heap.pop(), id = current.id;
    if (closed.has(id) || current.g !== costs.get(id)) continue;
    if (current.cost >= best - 1e-10) break;
    closed.add(id); expansions++;
    const finish = target.get(id);
    if (finish !== undefined && current.g + finish < best) { best = current.g + finish; goal = id; same = null; }
    const relax = (next, edge) => {
      const cost = current.g + edge;
      if (cost >= (costs.get(next) ?? Infinity)) return;
      costs.set(next, cost); prev.set(next, id); heap.push({ id: next, cost: cost + h(next), g: cost });
    };
    for (const crossing of hierarchy.crossings.get(id) ?? []) relax(crossing.id, crossing.cost);
    for (const [next, cost] of hierarchy.transfer(id)) relax(next, cost);
  }
  if (best === Infinity) return { status: 'no-known-route', length: Infinity, expansions, path: [], ...stats() };
  let ids = [];
  if (same) ids = witness(hierarchy, same.chunk, sourceByChunk.get(same.chunk), same.id);
  else {
    const coarse = [];
    for (let id = goal; id !== undefined; id = prev.get(id)) coarse.push(id);
    coarse.reverse();
    const first = coarse[0], firstChunk = chunkOf(graph, first);
    ids = witness(hierarchy, firstChunk, sourceByChunk.get(firstChunk), first);
    for (let i = 1; i < coarse.length; i++) {
      const a = coarse[i - 1], b = coarse[i];
      if (chunkOf(graph, a) === chunkOf(graph, b)) ids.push(...witness(hierarchy, chunkOf(graph, a), new Map([[a, 0]]), b).slice(1));
      else ids.push(b);
    }
    const last = coarse.at(-1), lastChunk = chunkOf(graph, last);
    const finish = bestGoal(localSearch(hierarchy, lastChunk, new Map([[last, 0]])).cost, targetByChunk.get(lastChunk));
    ids.push(...witness(hierarchy, lastChunk, new Map([[last, 0]]), finish.id).slice(1));
  }
  return { status: 'complete', length: best, expansions, path: [from, ...ids.map(id => graph.point(id)), to], ...stats() };
}
