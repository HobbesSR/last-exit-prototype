import { cellKey } from './analysis.ts';
import type { Cell } from '../types.ts';
import type { InterfaceRun, PieceInterface } from './types.ts';

/** Shared cell edges, coalesced into straight runs. These are opportunities, not traversability proofs. */
export function buildInterfaces(parts: readonly { id: string; cells: readonly Cell[] }[], portalWidth = 2): PieceInterface[] {
  if (!Number.isFinite(portalWidth) || portalWidth <= 0) throw new Error('Invalid portal width.');
  const owners = new Map<string, string>(), ids = new Set<string>();
  for (const part of parts) {
    if (!part.id || ids.has(part.id)) throw new Error('Interface owners need unique identities.');
    ids.add(part.id);
    for (const cell of part.cells) {
      const key = cellKey(cell);
      if (owners.has(key)) throw new Error('Interface ownership overlaps.');
      owners.set(key, part.id);
    }
  }
  const pairs = new Map<string, { a: string; b: string; edges: InterfaceRun[] }>();
  for (const part of parts) for (const c of part.cells) for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const other = owners.get(cellKey({ x: c.x + dx!, y: c.y + dy! }));
    if (!other || other === part.id) continue;
    const [a, b] = [part.id, other].sort(), key = JSON.stringify([a, b]);
    if (!pairs.has(key)) pairs.set(key, { a: a!, b: b!, edges: [] });
    pairs.get(key)!.edges.push({ axis: dx ? 'v' : 'h', x: c.x + dx!, y: c.y + dy!, length: 1 });
  }
  return [...pairs.values()].sort((a, b) => a.a.localeCompare(b.a) || a.b.localeCompare(b.b)).map(pair => {
    const lines = new Map<string, { axis: 'h' | 'v'; line: number; positions: number[] }>();
    for (const e of pair.edges) {
      const line = e.axis === 'h' ? e.y : e.x, pos = e.axis === 'h' ? e.x : e.y, key = `${e.axis}:${line}`;
      if (!lines.has(key)) lines.set(key, { axis: e.axis, line, positions: [] });
      lines.get(key)!.positions.push(pos);
    }
    const runs: InterfaceRun[] = [];
    for (const { axis, line, positions } of lines.values()) {
      positions.sort((a, b) => a - b);
      for (let i = 0; i < positions.length;) {
        const start = positions[i]!; let length = 1; i++;
        while (i < positions.length && positions[i] === start + length) { length++; i++; }
        runs.push({ axis, x: axis === 'h' ? start : line, y: axis === 'h' ? line : start, length });
      }
    }
    runs.sort((a, b) => a.axis.localeCompare(b.axis) || a.y - b.y || a.x - b.x);
    return { id: `interface:${JSON.stringify([pair.a, pair.b])}`, a: pair.a, b: pair.b, kind: 'shared-boundary', runs,
      length: pair.edges.length, longestRun: Math.max(...runs.map(r => r.length)), fragmentedRuns: runs.length,
      portalCandidates: runs.filter(r => r.length >= portalWidth).map(r => ({ ...r })) };
  });
}
