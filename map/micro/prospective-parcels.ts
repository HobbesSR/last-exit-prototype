import { clearFootprint } from '../kernel/margins.ts';
import { rect, type Shape } from '../../shared/shape.ts';
import { construct } from '../../shared/shape-construction.ts';
import type { Vec2 } from '../../shared/types.ts';
import { createAddressedArea } from './addressed.ts';
import { assemblyBlockers, assemblyFootprints, createBuilderCanvas, type CanvasAssembly } from './canvas.ts';
import { discoverCordWitness, type CordWitness } from './cord-witness.ts';
import { createFillMask, createAccessMask, shapesOverlap, shapesShareArea, validShape } from './geometry.ts';
import { areaContains, parcelArea } from './parcel-area.ts';
import type { RegionBrief } from './types.ts';
import type { PatchOffer, PreparedDelegation } from './delegation.ts';
import type { ExecutionContext, ExecutionPolicyData } from './delegation-execute.ts';
import { sameDelegationJSON } from './delegation-json.ts';

export interface ParcelHandle { readonly id: number }
export interface ParcelProposal { readonly revision: number; readonly area: readonly Shape[]; readonly witness: CordWitness }
export interface HandoffProposal { readonly revision: number; readonly prepared: PreparedDelegation; readonly witness: CordWitness }
export interface ParcelOptions {
  handoff?: Pick<ExecutionContext, 'prepareDelegation' | 'delegate'>;
  /** Immutable standing/access obligations; live cords are never placed here. */
  fixedAccess?: readonly Shape[];
  terminals?: readonly Vec2[];
  budget?: Parameters<typeof discoverCordWitness>[4];
}
type Parcel = { handle: ParcelHandle; area: Shape[]; assembly: CanvasAssembly | undefined; settled: boolean };
type Operation = { kind: 'assembly'; assembly: CanvasAssembly } | { kind: 'empty'; area: Shape[] } | { kind: 'parcel'; handle: ParcelHandle };
type Refusal = 'stale' | 'allocation' | 'canvas' | 'budget' | 'external' | 'interior' | 'handle' | 'populated' | 'handoff' | 'rejected' | 'partition';
type Failed = { ok: false; reason: Refusal; counters?: ReturnType<typeof discoverCordWitness>['counters'] };
type Proposed = { ok: true; proposal: ParcelProposal; counters: ReturnType<typeof discoverCordWitness>['counters'] } | Failed;

/** Check expansion work before materializing roofs or replaying assemblies. */
function assemblyWithinBudget(assembly: CanvasAssembly): boolean {
  if (assembly.elements.length > 4096) return false;
  let size = assembly.elements.length + (assembly.areas?.length ?? 0) + (assembly.access?.length ?? 0) + (assembly.extents?.length ?? 0);
  for (const e of assembly.elements) {
    size += e.template.parts.length + (e.template.roofs?.length ?? 0);
    if (e.template.parts.length > 1024 || size > 16384) return false;
    for (const roof of e.template.roofs ?? []) { size += roof.cells.length; if (size > 16384) return false; }
  }
  return size <= 16384;
}

/**
 * Optional, private transaction owner. Claim trials replay a detached canvas;
 * ordinary writes prove circulation before the canvas's atomic commit.
 * Hypothetical ownership is published only through one verified execution batch.
 * Claim and handoff probes consume no builder RNG or runtime IDs.
 */
export function createProspectiveParcels(input: RegionBrief, options: ParcelOptions = {}) {
  let brief = structuredClone(input);
  const fixed = structuredClone(options.fixedAccess ?? []);
  const terminals = structuredClone(options.terminals ?? []), budget = structuredClone(options.budget);
  let parcels: Parcel[] = [], operations: Operation[] = [], revision = 0, nextId = 1;
  // Ordinary assemblies only append. Parcel population is covered by its envelope,
  // so parcel replay/extension/cancellation never invalidates this private cache.
  const committedBlockers: Shape[] = [];
  const handoffContext = options.handoff;
  let acceptedOffers: PatchOffer[] = [], acceptedPolicy: ExecutionPolicyData | undefined, acceptedPlan: PreparedDelegation | undefined, executed = false;
  const handoffs = new WeakMap<HandoffProposal, { revision: number; offers: PatchOffer[]; policy: ExecutionPolicyData; prepared: PreparedDelegation; witness: CordWitness }>();
  const proposals = new WeakMap<ParcelProposal, { revision: number; area: Shape[]; witness: CordWitness; extend: ParcelHandle | undefined }>();
  if (fixed.length > 16384) return { ok: false as const, reason: 'budget' as const, counters: { meshBuilds: 0, sweeps: 0, paths: 0 } };
  if (fixed.some(s => !validShape(s))) throw new TypeError('Fixed access must contain valid convex shapes');
  const initial = discoverCordWitness(brief, [], terminals, undefined, budget);
  if (!initial.ok) return { ok: false as const, reason: initial.reason, counters: initial.counters };
  let canvas = createBuilderCanvas(brief, fixed);
  if (fixed.some(s => !canvas.access.contains(s))) return { ok: false as const, reason: 'canvas' as const };
  let witness = initial.witness, routingBrief = brief;
  const fail = (reason: Refusal): Failed => ({ ok: false, reason });
  const lookup = (handle: ParcelHandle) => parcels.find(p => p.handle === handle);
  const replay = (ps: Parcel[], ops = operations, target = brief) => {
    const trial = createBuilderCanvas(target, fixed);
    if (fixed.some(s => !trial.access.contains(s)) || ps.some(p => p.area.some(s => !trial.fill.contains(s)))) return null;
    for (const op of ops) {
      if (op.kind === 'assembly') { if (!trial.commit(op.assembly)) return null; }
      else if (op.kind === 'empty') { if (!trial.markEmpty(op.area)) return null; }
      else {
        const p = ps.find(p => p.handle === op.handle)!;
        if (p.assembly) { if (!trial.commit({ ...p.assembly, areas: p.area })) return null; }
        else if (p.settled && !trial.markEmpty(p.area)) return null;
      }
    }
    return trial;
  };
  const blockers = (ps: Parcel[], policy = acceptedPolicy): Shape[] => [
    ...ps.flatMap(p => p.area),
    ...committedBlockers,
    ...(policy?.blockers ?? []),
  ];
  const publish = (ps: Parcel[], ops: Operation[], trial: NonNullable<ReturnType<typeof replay>>, next: CordWitness) => {
    parcels = ps; operations = ops; canvas = trial; witness = next; revision++;
  };
  // Reservations live outside the append-only legacy ledger, and disappear on cancellation.
  const allocation = () => {
    const ledger = createAddressedArea(createFillMask(brief));
    const areas = [...canvas.addressed.areas, ...parcels.filter(p => !p.assembly && !p.settled).flatMap(p => p.area)];
    if (!ledger.markAll(areas)) throw new Error('Invalid parcel allocation ledger');
    return ledger;
  };
  const handoffPolicy = (policy: ExecutionPolicyData): ExecutionPolicyData => ({
    ...policy,
    blockers: [...(policy.blockers ?? []),
      ...operations.flatMap(op => op.kind === 'assembly' ? assemblyFootprints(op.assembly) : []),
      ...parcels.flatMap(p => p.area)],
  });
  const retainedProof = (prepared: PreparedDelegation): RegionBrief => {
    const children = prepared.children.flatMap(c => c.brief.cells);
    const childCells = new Set(children.map(c => `${c.x},${c.y}`));
    const threshold = new Set(clearFootprint(prepared.retained.portals, children).map(c => `${c.x},${c.y}`));
    // Only crossing thresholds may supply child-owned access context.
    return { ...prepared.retained, clearCells: (prepared.retained.clearCells ?? [])
      .filter(c => !childCells.has(`${c.x},${c.y}`) || threshold.has(`${c.x},${c.y}`)) };
  };
  const retainsAccess = (prepared: PreparedDelegation, proofBrief: RegionBrief, added: readonly Shape[] = []): boolean => {
    const proofAccess = createAccessMask(proofBrief);
    const obligations = [...fixed, ...added, ...operations.flatMap(op => op.kind === 'assembly' ? [...(op.assembly.access ?? [])]
      : op.kind === 'parcel' ? [...(lookup(op.handle)?.assembly?.access ?? [])] : [])];
    const childSquares = prepared.children.flatMap(c => c.brief.cells.map(cell =>
      rect(cell.x * brief.cellSize, cell.y * brief.cellSize, brief.cellSize, brief.cellSize)));
    return !obligations.some(s => !proofAccess.contains(s) || childSquares.some(square => shapesShareArea(s, square)))
      && !terminals.some(p => childSquares.some(s => s.kind === 'rect' && p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h));
  };
  const coordinator = {
    probeHandoff(additional: readonly PatchOffer[], policyData?: ExecutionPolicyData) {
      if (!handoffContext || executed) return fail('handoff');
      if (!Array.isArray(additional) || !additional.length) throw new TypeError('Handoff needs additional offers');
      const policy = structuredClone(policyData ?? acceptedPolicy ?? {});
      if (acceptedPolicy && !sameDelegationJSON(policy, acceptedPolicy)) return fail('handoff');
      const offers = [...structuredClone(acceptedOffers), ...structuredClone(additional)];
      // Preparation needs all physical occupancy and pessimistic envelopes, not merely
      // the collision subset used by the routing proof.
      const executionPolicy = handoffPolicy(policy);
      const prepared = handoffContext.prepareDelegation(offers, executionPolicy);
      if (prepared.rejected.length || prepared.children.length !== offers.length) return fail('rejected');
      const trial = replay(parcels, operations, prepared.retained);
      if (!trial) return fail('canvas');
      // Child-owned clear-margin cells are access context for a crossing, not a
      // licence to route through the child interior.
      const proofBrief = retainedProof(prepared);
      if (!retainsAccess(prepared, proofBrief)) return fail('canvas');
      const found = discoverCordWitness(proofBrief, blockers(parcels, policy), terminals, witness, budget);
      if (!found.ok) return { ...fail(found.reason), counters: found.counters };
      const proposal: HandoffProposal = { revision, prepared: structuredClone(prepared), witness: structuredClone(found.witness) };
      handoffs.set(proposal, { revision, offers, policy, prepared, witness: found.witness });
      return { ok: true as const, proposal, counters: found.counters };
    },
    acceptHandoff(proposal: HandoffProposal) {
      const saved = handoffs.get(proposal);
      if (!saved || saved.revision !== revision || executed) return fail('stale');
      const trial = replay(parcels, operations, saved.prepared.retained);
      if (!trial) return fail('canvas');
      brief = structuredClone(saved.prepared.retained);
      routingBrief = retainedProof(saved.prepared);
      acceptedOffers = saved.offers; acceptedPolicy = saved.policy; acceptedPlan = saved.prepared;
      publish(parcels, operations, trial, saved.witness);
      handoffs.delete(proposal);
      return { ok: true as const };
    },
    executeHandoffs() {
      if (!handoffContext || executed || !acceptedPlan || !acceptedPolicy) return fail('handoff');
      const policy = handoffPolicy(acceptedPolicy);
      const prepared = handoffContext.prepareDelegation(acceptedOffers, policy);
      if (prepared.rejected.length || !sameDelegationJSON(prepared, acceptedPlan)) return fail('partition');
      if (!replay(parcels, operations, prepared.retained)) return fail('canvas');
      const proofBrief = retainedProof(prepared);
      if (!retainsAccess(prepared, proofBrief)) return fail('canvas');
      const found = discoverCordWitness(proofBrief, blockers(parcels), terminals, witness, budget);
      if (!found.ok) return { ...fail(found.reason), counters: found.counters };
      executed = true;
      const dispatch = handoffContext.delegate(acceptedOffers, policy);
      if (!sameDelegationJSON(dispatch.prepared, prepared)) throw new Error('Delegation execution changed the verified partition');
      return { ok: true as const, dispatch };
    },
    get revision() { return revision; },
    get witness(): CordWitness { return structuredClone(witness); },
    get elements() { return structuredClone(canvas.elements); },
    get fill() { return createFillMask(brief); },
    get access() { return createAccessMask(brief); },
    get addressed() { return allocation(); },
    get parcels() { return parcels.map(p => ({ handle: p.handle, area: structuredClone(p.area), populated: !!p.assembly, settled: p.settled })); },
    fits(shape: Shape) { return canvas.fits(shape) && !parcels.some(p => p.area.some(a => shapesOverlap(shape, a))); },
    spaced(shape: Shape, clearance = 0) { return canvas.spaced(shape, clearance); },
    probeClaim(shapes: readonly Shape[], extend?: ParcelHandle): Proposed {
      const prior = extend ? lookup(extend) : undefined;
      if (extend && (!prior || prior.settled)) return fail('handle');
      if ((!prior && parcels.length >= 256) || shapes.length > 1024) return fail('budget');
      const inputs = [...(prior?.area ?? []), ...shapes];
      if (inputs.length > 4096 || inputs.reduce((n, s) => n + (s?.kind === 'polygon' && Array.isArray(s.points) ? s.points.length : 4), 0) > 16384)
        return fail('budget');
      let area: Shape[];
      try { area = parcelArea(inputs); } catch (error) { if (error instanceof RangeError) return fail('budget'); throw error; }
      if (!area.length) throw new TypeError('A parcel must have nonempty area');
      if (area.length + parcels.filter(p => p !== prior).reduce((n, p) => n + p.area.length, 0) > 4096) return fail('budget');
      if (prior && !areaContains(area, prior.area)) return fail('allocation');
      if (prior?.assembly?.access?.length) {
        const added = construct(area).subtract(prior.area).pieces();
        if (added.some(s => prior.assembly!.access!.some(a => shapesOverlap(s, a)))) return fail('allocation');
      }
      const other = parcels.filter(p => p !== prior);
      // Reconstruct without the own populated intent, so extension does not hit itself.
      const otherOps = operations.filter(op => op.kind !== 'parcel' || op.handle !== extend);
      const otherCanvas = replay(other, otherOps)!;
      if (area.some(s => !otherCanvas.fits(s))) return fail('allocation');
      const occupied = assemblyFootprints({ elements: otherCanvas.elements });
      if (area.some(s => otherCanvas.addressed.areas.some(a => shapesShareArea(s, a))
        || occupied.some(a => shapesOverlap(s, a))
        || other.some(p => p.area.some(a => shapesShareArea(s, a))))) return fail('allocation');
      const candidate: Parcel = { handle: prior?.handle ?? Object.freeze({ id: nextId }), area, assembly: prior?.assembly, settled: false };
      const ps = prior ? parcels.map(p => p === prior ? candidate : p) : [...parcels, candidate];
      const trial = replay(ps);
      if (!trial) return fail('canvas');
      const found = discoverCordWitness(routingBrief, blockers(ps), terminals, witness, budget);
      if (!found.ok) return { ...fail(found.reason), counters: found.counters };
      const proposal: ParcelProposal = { revision, area: structuredClone(area), witness: structuredClone(found.witness) };
      proposals.set(proposal, { revision, area, witness: found.witness, extend });
      return { ok: true, proposal, counters: found.counters };
    },
    acceptClaim(proposal: ParcelProposal): { ok: true; handle: ParcelHandle } | Failed {
      const saved = proposals.get(proposal);
      if (!saved || saved.revision !== revision) return fail('stale');
      const prior = saved.extend ? lookup(saved.extend) : undefined;
      const handle = prior?.handle ?? Object.freeze({ id: nextId });
      const p: Parcel = { handle, area: structuredClone(saved.area), assembly: prior?.assembly, settled: false };
      const ps = prior ? parcels.map(old => old === prior ? p : old) : [...parcels, p];
      const ops = prior ? operations : [...operations, { kind: 'parcel' as const, handle }];
      const trial = replay(ps, ops);
      if (!trial) return fail('canvas');
      publish(ps, ops, trial, saved.witness);
      if (!prior) nextId++;
      proposals.delete(proposal);
      return { ok: true, handle };
    },
    tryClaim(shapes: readonly Shape[], extend?: ParcelHandle) {
      const proposed = coordinator.probeClaim(shapes, extend);
      return proposed.ok ? coordinator.acceptClaim(proposed.proposal) : proposed;
    },
    populate(handle: ParcelHandle, assembly: CanvasAssembly): { ok: true } | Failed {
      const p = lookup(handle);
      if (!p || p.settled) return fail('handle');
      if (p.assembly) return fail('populated');
      const owned = structuredClone(assembly);
      if (owned.elements.length + canvas.elements.length > 4096 || !assemblyWithinBudget(owned)) return fail('budget');
      if (acceptedPlan && !retainsAccess(acceptedPlan, routingBrief, owned.access)) return fail('canvas');
      const intent = owned.areas ?? owned.elements.map(e => rect(e.x, e.y, e.template.w, e.template.h));
      const physical = assemblyFootprints(owned);
      if (intent.length + physical.length > 16384) return fail('budget');
      if (!areaContains(p.area, [...intent, ...physical])) return fail('allocation');
      const next = { ...p, assembly: owned }, ps = parcels.map(old => old === p ? next : old);
      const trial = replay(ps);
      if (!trial) return fail('canvas');
      // Access requested during population becomes fixed; it cannot run through another envelope.
      if ((owned.access ?? []).some(a => parcels.some(other => other !== p && other.area.some(s => shapesOverlap(a, s))))) return fail('canvas');
      publish(ps, operations, trial, witness);
      return { ok: true };
    },
    settle(handle: ParcelHandle, outcome: 'populated' | 'empty'): { ok: true } | Failed {
      if (outcome !== 'populated' && outcome !== 'empty') throw new TypeError('Unknown parcel settlement');
      const p = lookup(handle);
      if (!p || p.settled) return fail('handle');
      if (!!p.assembly !== (outcome === 'populated')) return fail('populated');
      const ps = parcels.map(old => old === p ? { ...p, settled: true } : old), trial = replay(ps);
      if (!trial) return fail('canvas');
      publish(ps, operations, trial, witness);
      return { ok: true };
    },
    cancel(handle: ParcelHandle): { ok: true } | Failed {
      const p = lookup(handle);
      if (!p) return fail('handle');
      if (p.assembly) return fail('populated');
      const ps = parcels.filter(old => old !== p), ops = operations.filter(op => op.kind !== 'parcel' || op.handle !== handle);
      const trial = replay(ps, ops)!;
      // The old proof remains valid when an envelope disappears.
      publish(ps, ops, trial, witness);
      return { ok: true };
    },
    commit(assembly: CanvasAssembly): boolean {
      if (operations.length >= 1024) return false;
      const owned = structuredClone(assembly);
      if (owned.elements.length + canvas.elements.length > 4096 || !assemblyWithinBudget(owned)) return false;
      if (acceptedPlan && !retainsAccess(acceptedPlan, routingBrief, owned.access)) return false;
      const intent = owned.areas ?? owned.elements.map(e => rect(e.x, e.y, e.template.w, e.template.h));
      if ([...intent, ...assemblyFootprints(owned), ...(owned.access ?? [])].some(a => parcels.some(p => p.area.some(s => shapesOverlap(a, s))))) return false;
      const ops: Operation[] = [...operations, { kind: 'assembly', assembly: owned }];
      const addedBlockers = assemblyBlockers(owned);
      const found = discoverCordWitness(routingBrief, [...blockers(parcels), ...addedBlockers], terminals, witness, budget);
      if (!found.ok) return false;
      // Search first; canvas.commit itself is atomic. No live write occurs on either refusal.
      if (!canvas.commit(owned)) return false;
      committedBlockers.push(...addedBlockers);
      publish(parcels, ops, canvas, found.witness);
      return true;
    },
    markEmpty(shapes: readonly Shape[]): boolean {
      if (operations.length >= 1024 || shapes.length > 1024) return false;
      const area = structuredClone([...shapes]);
      if (area.some(a => parcels.some(p => p.area.some(s => shapesShareArea(a, s))))) return false;
      if (!canvas.markEmpty(area)) return false;
      publish(parcels, [...operations, { kind: 'empty', area }], canvas, witness);
      return true;
    },
  };
  return { ok: true as const, coordinator, counters: initial.counters };
}

export type ProspectiveParcels = NonNullable<ReturnType<typeof createProspectiveParcels>['coordinator']>;
