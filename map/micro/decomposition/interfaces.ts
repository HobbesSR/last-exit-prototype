import { boundaryRuns } from '../../kernel/run.ts';
import type { Cell } from '../types.ts';
import type { PieceInterface } from './types.ts';

/** Shared cell edges, coalesced into straight runs. These are opportunities, not traversability proofs. */
export function buildInterfaces(parts: readonly { id: string; cells: readonly Cell[] }[], portalWidth = 2): PieceInterface[] {
  if (!Number.isFinite(portalWidth) || portalWidth <= 0) throw new Error('Invalid portal width.');
  return boundaryRuns(parts).map(({ a, b, runs }) => ({ id: `interface:${JSON.stringify([a, b])}`, a, b, kind: 'shared-boundary', runs,
    length: runs.reduce((sum, r) => sum + r.length, 0), longestRun: Math.max(...runs.map(r => r.length)), fragmentedRuns: runs.length,
    portalCandidates: runs.filter(r => r.length >= portalWidth).map(r => ({ ...r })) }));
}
