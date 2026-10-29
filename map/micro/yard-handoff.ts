import { rect } from '../../shared/shape.ts';
import { createRegionMask } from './geometry.ts';
import { createProspectiveParcels } from './prospective-parcels.ts';
import type { PatchOffer } from './delegation.ts';
import type { ExecutionContext } from './delegation-execute.ts';
import type { RegionBrief, RegionElement } from './types.ts';

export type YardOutcome = 'no-eligible-candidates' | 'init' | 'claim' | 'populate' | 'settle' | 'all-refused' | 'delegated';
export interface YardDiagnostics<O extends string> {
  briefId: string;
  outcome: O | YardOutcome;
  reason?: string;
  considered: number;
  filtered: number;
  probed: number;
  accepted: number;
  refusals: Record<string, number>;
  eligibleOffers: PatchOffer[];
  probes: Array<{ key: string; verdict: 'accepted' | 'refused'; reason?: string }>;
}
export const yardDiagnostics = <O extends string>(briefId: string, outcome: O | YardOutcome): YardDiagnostics<O> =>
  ({ briefId, outcome, considered: 0, filtered: 0, probed: 0, accepted: 0, refusals: {}, eligibleOffers: [], probes: [] });

const BODY = 2;
type Box = { x: number; y: number; w: number; h: number };

/** Run the shared optional yard handoff transaction, leaving candidate policy to the builder. */
export function delegateYardCandidates<O extends string>(brief: RegionBrief, context: ExecutionContext, options: {
  retainedBoxes: Box[]; steps: [number, number][]; elements: RegionElement[]; label: string;
  offersFor: (reserved: Set<string>, diagnostics: YardDiagnostics<O>) => PatchOffer[];
  observe?: ((diagnostics: YardDiagnostics<O>) => void) | undefined;
}): void {
  const { retainedBoxes: boxes, steps, elements, label, offersFor, observe } = options;
  const diagnostics: YardDiagnostics<O> = yardDiagnostics<O>(brief.id, 'no-eligible-candidates');
  const report = (outcome: YardDiagnostics<O>['outcome'], reason?: string) => {
    diagnostics.outcome = outcome;
    if (reason !== undefined) diagnostics.reason = reason;
    observe?.(structuredClone(diagnostics));
  };
  const size = brief.cellSize;
  // The retained-portal policy requires each original portal's owned seam
  // cells to stay with the parent. These checks are necessary refusals, so
  // discard them before constructing the optional routing coordinator.
  const reserved = new Set<string>();
  for (const box of boxes) for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) reserved.add(`${x},${y}`);
  for (const [x, y] of steps) for (let j = y; j < y + BODY; j++) for (let i = x; i < x + BODY; i++) reserved.add(`${i},${j}`);
  const owned = createRegionMask(brief);
  for (const p of brief.portals) for (let i = 0; i < p.length; i++) {
    const before = p.axis === 'h' ? { x: p.x + i, y: p.y - 1 } : { x: p.x - 1, y: p.y + i };
    const after = p.axis === 'h' ? { x: p.x + i, y: p.y } : { x: p.x, y: p.y + i };
    const cell = owned.has(before.x, before.y) ? before : after;
    reserved.add(`${cell.x},${cell.y}`);
  }
  const offers = offersFor(reserved, diagnostics);
  diagnostics.eligibleOffers = offers;
  if (!offers.length) { report('no-eligible-candidates'); return; }
  const fixedAccess = steps.map(([x, y]) => rect(x * size, y * size, BODY * size, BODY * size));
  const terminals = steps.map(([x, y]) => ({ x: (x + BODY / 2) * size, y: (y + BODY / 2) * size }));
  const created = createProspectiveParcels(brief, { handoff: context, fixedAccess, terminals });
  // Independently sited retained content remains valid when the optional continuous search cannot prove it.
  if (!created.ok) { report('init', created.reason); return; }
  const coordinator = created.coordinator;
  const claim = coordinator.tryClaim(boxes.map(box => rect(box.x * size, box.y * size, box.w * size, box.h * size)));
  if (!claim.ok) { report('claim', claim.reason); return; }
  const populated = coordinator.populate(claim.handle, { elements });
  if (!populated.ok) { report('populate', populated.reason); return; }
  const settled = coordinator.settle(claim.handle, 'populated');
  if (!settled.ok) { report('settle', settled.reason); return; }

  let accepted = false;
  const transferred = new Set<string>();
  for (const offer of offers) {
    if (offer.cells.some(c => transferred.has(`${c.x},${c.y}`))) continue;
    diagnostics.probed++;
    const proposal = coordinator.probeHandoff([offer], { externalPortals: 'retained' });
    if (!proposal.ok) {
      diagnostics.probes.push({ key: offer.key, verdict: 'refused', reason: proposal.reason });
      diagnostics.refusals[proposal.reason] = (diagnostics.refusals[proposal.reason] ?? 0) + 1;
      continue;
    }
    const acceptance = coordinator.acceptHandoff(proposal.proposal);
    if (acceptance.ok) {
      accepted = true;
      diagnostics.accepted++;
      diagnostics.probes.push({ key: offer.key, verdict: 'accepted' });
      for (const c of offer.cells) transferred.add(`${c.x},${c.y}`);
    } else {
      diagnostics.probes.push({ key: offer.key, verdict: 'refused', reason: acceptance.reason });
      diagnostics.refusals[acceptance.reason] = (diagnostics.refusals[acceptance.reason] ?? 0) + 1;
    }
  }
  if (accepted && !coordinator.executeHandoffs().ok) throw new Error(`Verified ${label} handoff could not execute.`);
  report(accepted ? 'delegated' : 'all-refused');
}

/** Corner and centered edge boxes in their original interleaved order. */
export function yardExtentBoxes(cells: ReadonlyArray<{ x: number; y: number }>): { boxes: Box[]; minX: number; minY: number; width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cell of cells) {
    minX = Math.min(minX, cell.x); maxX = Math.max(maxX, cell.x);
    minY = Math.min(minY, cell.y); maxY = Math.max(maxY, cell.y);
  }
  const width = maxX - minX + 1, height = maxY - minY + 1;
  const dims = (n: number) => [...new Set([Math.floor(n / 2), Math.floor(n / 3), 3].filter(v => v >= 3))];
  const boxes: Box[] = [];
  for (const w of dims(width)) for (const h of dims(height)) {
    for (const x of [minX, maxX - w + 1]) for (const y of [minY, maxY - h + 1]) boxes.push({ x, y, w, h });
    boxes.push({ x: minX + Math.floor((width - w) / 2), y: minY, w, h },
      { x: minX + Math.floor((width - w) / 2), y: maxY - h + 1, w, h },
      { x: minX, y: minY + Math.floor((height - h) / 2), w, h },
      { x: maxX - w + 1, y: minY + Math.floor((height - h) / 2), w, h });
  }
  return { boxes, minX, minY, width, height };
}

