import { cellKey, compareCells } from '../kernel/cell.ts';
import type { Cell, Portal, RegionBrief } from '../kernel/contract.ts';
import { boundaryRuns } from '../kernel/run.ts';
import type { Run } from '../kernel/run.ts';
import { clearFootprint } from '../kernel/margins.ts';
import { checkedMargins, checkedRegionCells, LIMITS } from './limits.ts';
import { clipHints, hintErrors } from './hints.ts';
import { inheritBriefMargins } from './margins.ts';
import { createFillMask, createRegionMask, travelClear, validShape } from './geometry.ts';
import { hunterClearance, portalStands } from './portals.ts';
import { delegationSeed } from './random.ts';
import type { Shape } from '../../shared/shape.ts';

export interface PatchOffer {
  /** Stable builder-authored identity. Use patchFootprintKey for automatic offers. */
  key: string;
  cells: Cell[];
  type: string;
  parameters?: RegionBrief['parameters'];
  reasonTags?: string[];
  /** Advice addressed to this child. Parent guidance is not forwarded implicitly. */
  guidance?: RegionBrief['guidance'];
}
export interface PreparedPatch { key: string; brief: RegionBrief }
export interface PatchRejection { key: string; reason: string }
export interface BriefCrossing { a: string; b: string; portal: Portal }
export interface PreparedDelegation {
  retained: RegionBrief;
  children: PreparedPatch[];
  crossings: BriefCrossing[];
  rejected: PatchRejection[];
}
export interface PatchPreparationPolicy {
  /** Explicit receiving-builder policy. Null accepts; a reason refuses the candidate. Must be pure. */
  receiving: (brief: RegionBrief, offer: PatchOffer) => string | null;
  /** Pilot keeps external runs retained. Broader callers may transfer a whole run to one child. */
  externalPortals?: 'retained' | 'whole-child';
  /** Whole cells reserved for the parent's geometry or intentional use. */
  protectedCells?: Cell[];
  /** Clear footprints that must not be delegated, e.g. declared door approaches. */
  protectedRuns?: Run[];
  /** Already placed collision geometry, supplied explicitly, never read from neighboring builders. */
  blockers?: Shape[];
}

const orderCells = (cells: readonly Cell[]): Cell[] => cells.map(c => ({ x: c.x, y: c.y })).sort(compareCells);
const orderRuns = <R extends Run>(runs: readonly R[]): R[] => [...runs].sort((a, b) => a.axis.localeCompare(b.axis) || a.y - b.y || a.x - b.x || a.length - b.length);
const sameRun = (a: Run, b: Run): boolean => a.axis === b.axis && a.x === b.x && a.y === b.y && a.length === b.length;
const record = (value: NonNullable<RegionBrief['parameters']>): NonNullable<RegionBrief['parameters']> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(v => !['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v)))
    throw new Error('Parameters and guidance need finite scalar records.');
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
};
class InfeasiblePatch extends Error {}

/** Full row-major coordinate encoding, not a hash: no footprint identity collisions. */
export function patchFootprintKey(cells: readonly Cell[]): string {
  return `cells:${checkedRegionCells(cells).map(cellKey).join(';')}`;
}

function insideCells(run: Run, owned: ReadonlySet<string>): Cell[] {
  return Array.from({ length: run.length }, (_, i) => {
    const before = run.axis === 'h' ? { x: run.x + i, y: run.y - 1 } : { x: run.x - 1, y: run.y + i };
    const after = run.axis === 'h' ? { x: run.x + i, y: run.y } : { x: run.x, y: run.y + i };
    return owned.has(cellKey(before)) ? before : after;
  });
}

/** Shared input normalization; execution need not construct an unchanged one-owner partition. */
export function canonicalDelegationBrief(input: RegionBrief): RegionBrief {
  const brief = structuredClone(input);
  if (typeof brief.id !== 'string' || !brief.id || typeof brief.type !== 'string' || !brief.type || !Number.isSafeInteger(brief.seed) || !Number.isFinite(brief.cellSize) || brief.cellSize <= 0)
    throw new Error('Preparation needs a stable brief identity, type, integer seed and positive cell size.');
  brief.cells = checkedRegionCells(brief.cells);
  portalStands(brief);
  const hints = hintErrors(brief);
  if (hints.length) throw new Error(hints.join(' '));
  brief.portals = orderRuns(brief.portals).sort((a, b) => a.id.localeCompare(b.id));
  if (brief.hints) brief.hints = orderRuns(brief.hints);
  if (brief.internalGuaranteed) brief.internalGuaranteed = orderRuns(brief.internalGuaranteed);
  const owned = new Set(brief.cells.map(cellKey)), zoned = new Set<string>();
  const zones = new Map<string, RegionBrief['zones'][number]>();
  for (const zone of brief.zones) {
    if (!Number.isInteger(zone.tier) || zone.tier < 1 || zone.tier > 5 || !Number.isInteger(zone.bonus) || zone.bonus < 0
      || !Number.isFinite(zone.lootChance) || zone.lootChance < 0 || zone.lootChance > 1) throw new Error('Invalid zone context.');
    const k = JSON.stringify([zone.tier, zone.bonus, zone.lootChance]);
    if (!zones.has(k)) zones.set(k, { tier: zone.tier, bonus: zone.bonus, lootChance: zone.lootChance, cells: [] });
    for (const cell of zone.cells) {
      if (!owned.has(cellKey(cell)) || zoned.has(cellKey(cell))) throw new Error('Zones must partition original ownership.');
      zoned.add(cellKey(cell)); zones.get(k)!.cells.push(cell);
    }
  }
  if (zoned.size !== owned.size) throw new Error('Zones must partition original ownership.');
  brief.zones = [...zones].sort(([a], [b]) => a.localeCompare(b)).map(([, z]) => ({ ...z, cells: orderCells(z.cells) }));
  if (brief.parameters !== undefined) brief.parameters = record(brief.parameters);
  if (brief.guidance !== undefined) brief.guidance = record(brief.guidance);
  for (const field of ['fillCells', 'clearCells'] as const) if (brief[field]) {
    const cells = brief[field]!;
    if (cells.some(c => !c || !Number.isSafeInteger(c.x) || !Number.isSafeInteger(c.y)) || new Set(cells.map(cellKey)).size !== cells.length)
      throw new Error(`Invalid ${field}.`);
    if (field === 'fillCells' && cells.some(c => !owned.has(cellKey(c)))) throw new Error('Fill must stay inside ownership.');
    if (field === 'clearCells' && cells.some(c => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (owned.has(`${c.x + dx},${c.y + dy}`)) return false;
      return true;
    }))
      throw new Error('Clear cells must be nearby access context.');
    brief[field] = orderCells(cells);
  }
  const fill = new Set((brief.fillCells ?? []).map(cellKey));
  if ((brief.clearCells ?? []).some(c => fill.has(cellKey(c)))) throw new Error('Clear cells cannot be available for filling.');
  const normalized = checkedMargins(brief);
  // Apply original guarantees before clipping them into children. This also makes
  // preparation idempotent when a caller supplied fill exclusions but omitted a
  // guaranteed run's footprint from that explicitly supplied margin context.
  const result = inheritBriefMargins(normalized, [normalized])[0]!;
  if (!result.hints?.length) delete result.hints;
  return result;
}

function localBrief(parent: RegionBrief, cells: Cell[], offer?: PatchOffer): RegionBrief {
  const owned = new Set(cells.map(cellKey));
  const hints = clipHints(parent.hints ?? [], parent.cells, cells);
  const brief: RegionBrief = offer ? {
    id: `${parent.id}/delegate/${encodeURIComponent(offer.key)}`, seed: delegationSeed(parent.seed, offer.key),
    type: offer.type,
    delegation: { sourceBuilder: parent.type, reasonTags: [...new Set(offer.reasonTags ?? [])].sort() },
    cellSize: parent.cellSize, cells, zones: [], portals: [],
  // These private intermediate briefs are copied by inheritBriefMargins before
  // crossing the preparation boundary; avoid copying fields replaced below.
  } : { ...parent, cells, portals: [], internalGuaranteed: [] };
  if (offer?.parameters !== undefined) brief.parameters = record(offer.parameters);
  const guidance = offer ? offer.guidance : parent.guidance;
  if (guidance !== undefined) brief.guidance = record(guidance);
  brief.zones = parent.zones.map(z => ({ ...z, cells: z.cells.filter(c => owned.has(cellKey(c))) })).filter(z => z.cells.length);
  brief.fillCells = parent.fillCells!.filter(c => owned.has(cellKey(c)));
  // Clear context is filtered by inheritBriefMargins, not copied as invented playable space.
  brief.clearCells = [];
  if (hints.length) brief.hints = hints; else delete brief.hints;
  return brief;
}

/**
 * Check interface composition by inference, assuming each leaf fulfills its own portal promise.
 * Works for decomposition as well as later delegation; no retained-only routing assumption.
 * Geometry remains an elective separate check. At every nesting level run this against that
 * level's original brief, so a descendant cannot drop the obligation inherited from its ancestor.
 */
export function validateBriefPartition(parent: RegionBrief, children: readonly RegionBrief[]): string[] {
  const errors: string[] = [];
  try {
    const original = new Set(parent.cells.map(cellKey)), owners = new Map<string, string>(), ids = new Set<string>();
    checkedRegionCells(parent.cells); portalStands(parent);
    const standsByOwner = new Map<string, ReturnType<typeof portalStands>>();
    for (const child of children) {
      if (!child.id || ids.has(child.id)) throw new Error('Partition owners need unique identities.');
      ids.add(child.id);
      if (child.cellSize !== parent.cellSize) throw new Error('Partition scales must agree.');
      checkedRegionCells(child.cells); standsByOwner.set(child.id, portalStands(child));
      for (const c of child.cells) {
        if (!original.has(cellKey(c)) || owners.has(cellKey(c))) throw new Error('Partition ownership must be disjoint and inside the parent.');
        owners.set(cellKey(c), child.id);
      }
    }
    if (owners.size !== original.size) throw new Error('Partition must exhaust original ownership.');
    const external = new Map<string, string>();
    for (const portal of parent.portals) {
      const inherited = new Set(insideCells(portal, original).map(c => owners.get(cellKey(c))!));
      if (inherited.size !== 1) throw new Error(`External portal ${portal.id} cannot be split between owners.`);
      const owner = [...inherited][0]!;
      if (!children.find(c => c.id === owner)!.portals.some(p => p.id === portal.id && sameRun(p, portal)))
        throw new Error(`External portal ${portal.id} must be inherited whole.`);
      external.set(portal.id, owner);
    }
    const links = new Map<string, Set<string>>(children.map(c => [c.id, new Set<string>()]));
    const portalOwners = new Map<string, Array<{ child: RegionBrief; portal: Portal }>>();
    for (const child of children) for (const portal of child.portals) {
      if (!portalOwners.has(portal.id)) portalOwners.set(portal.id, []);
      portalOwners.get(portal.id)!.push({ child, portal });
    }
    for (const [id, occurrences] of portalOwners) {
      if (external.has(id)) {
        if (occurrences.length !== 1 || occurrences[0]!.child.id !== external.get(id)) throw new Error(`External portal ${id} has extra owners.`);
        continue;
      }
      if (occurrences.length !== 2 || !sameRun(occurrences[0]!.portal, occurrences[1]!.portal)) throw new Error(`Portal ${id} needs an identical paired crossing.`);
      const [a, b] = occurrences as [{ child: RegionBrief; portal: Portal }, { child: RegionBrief; portal: Portal }];
      const aStands = standsByOwner.get(a.child.id)!.find(p => p.portal.id === id)!;
      const bStands = standsByOwner.get(b.child.id)!.find(p => p.portal.id === id)!;
      if (!aStands.points.length || !bStands.points.length) throw new Error(`Portal ${id} is too short for a hunter crossing.`);
      if (aStands.inward.x !== -bStands.inward.x || aStands.inward.y !== -bStands.inward.y)
        throw new Error(`Portal ${id} must face opposing owners.`);
      // Every inside segment must face the paired owner, not a third owner or outside.
      const run = a.portal;
      for (let i = 0; i < run.length; i++) {
        const sides = run.axis === 'h' ? [{ x: run.x + i, y: run.y - 1 }, { x: run.x + i, y: run.y }]
          : [{ x: run.x - 1, y: run.y + i }, { x: run.x, y: run.y + i }];
        if (!sides.every(c => [a.child.id, b.child.id].includes(owners.get(cellKey(c))!))) throw new Error(`Portal ${id} does not join its paired owners.`);
      }
      links.get(a.child.id)!.add(b.child.id); links.get(b.child.id)!.add(a.child.id);
    }
    for (const seam of boundaryRuns(children)) if (!links.get(seam.a)!.has(seam.b)) errors.push(`Adjacent owners ${seam.a} and ${seam.b} need a crossing.`);
    if (children.length) {
      const reached = new Set([children[0]!.id]), queue = [...reached];
      for (let i = 0; i < queue.length; i++) for (const next of links.get(queue[i]!)!) if (!reached.has(next)) { reached.add(next); queue.push(next); }
      if (reached.size !== children.length) errors.push('Partition crossing graph disconnects original reachability.');
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return errors;
}

// Both initial decomposition and patch preparation finish through the same
// margin inheritance and interface checks. The hook preserves patch geometry
// rejection precedence before partition validation; `fail` lets each caller
// report a bad partition as its own kind of error.
function finishPartition(parent: RegionBrief, children: readonly RegionBrief[], fail: (message: string) => Error,
  beforeValidation?: (briefs: RegionBrief[]) => void): RegionBrief[] {
  const briefs = inheritBriefMargins(parent, children).map(b => ({ ...b, portals: [...b.portals].sort((a, b) => a.id.localeCompare(b.id)) }));
  beforeValidation?.(briefs);
  const errors = validateBriefPartition(parent, briefs);
  if (errors.length) throw fail(errors.join(' '));
  return briefs;
}

/**
 * Prepare planner-authored owners, including a partition with no retained owner.
 * A partition that fails validation is a planner contract error, not an ordinary
 * infeasible patch, so it throws a plain error.
 */
export function prepareInitialPartition(input: RegionBrief, children: readonly RegionBrief[]): RegionBrief[] {
  const parent = canonicalDelegationBrief(input);
  return finishPartition(parent, children.map(canonicalDelegationBrief), message => new Error(`Initial partition: ${message}`));
}

/** Prepare builder-authored offers only; malformed requests throw, ordinary infeasibility retains cells with reasons. */
export function prepareDelegation(input: RegionBrief, offers: readonly PatchOffer[], policy: PatchPreparationPolicy): PreparedDelegation {
  if (typeof policy?.receiving !== 'function') throw new Error('Preparation needs explicit receiving-builder feasibility policy.');
  return prepareCanonicalDelegation(canonicalDelegationBrief(input), offers, policy);
}

/** Internal executor path: input has already passed canonicalDelegationBrief or preparation. */
export function prepareCanonicalDelegation(parent: RegionBrief, offers: readonly PatchOffer[], policy: PatchPreparationPolicy): PreparedDelegation {
  if (typeof policy?.receiving !== 'function') throw new Error('Preparation needs explicit receiving-builder feasibility policy.');
  const owned = new Set(parent.cells.map(cellKey));
  const keys = new Set<string>(), requested = new Set<string>();
  const normalized = offers.map(offer => {
    if (!offer || typeof offer.key !== 'string' || !offer.key || keys.has(offer.key) || typeof offer.type !== 'string' || !offer.type)
      throw new Error('Offers need unique nonempty stable keys and explicit types.');
    keys.add(offer.key);
    // encodeURIComponent refuses unpaired surrogates, which would not have a unique UTF-8 identity.
    encodeURIComponent(offer.key);
    const cells = checkedRegionCells(offer.cells);
    if (offer.parameters !== undefined) record(offer.parameters);
    if (offer.guidance !== undefined) record(offer.guidance);
    if (offer.reasonTags && (!Array.isArray(offer.reasonTags) || offer.reasonTags.some(t => typeof t !== 'string'))) throw new Error('Reason tags must be strings.');
    for (const c of cells) {
      if (!owned.has(cellKey(c)) || requested.has(cellKey(c))) throw new Error('Offered ownership must be disjoint and inside the parent.');
      requested.add(cellKey(c));
    }
    const { cells: _requestedCells, ...metadata } = offer;
    return { ...structuredClone(metadata), cells };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const protection = policy.protectedCells ?? [];
  if (!Array.isArray(protection) || protection.some(c => !c || !Number.isInteger(c.x) || !Number.isInteger(c.y)))
    throw new Error('Protected cells must have whole addresses.');
  const protectedCells = new Set(protection.map(cellKey));
  if ([...protectedCells].some(k => !owned.has(k))) throw new Error('Protected cells must be owned by the parent.');
  if ((policy.protectedRuns ?? []).some(r => !r || !['h', 'v'].includes(r.axis) || ![r.x, r.y, r.length].every(Number.isInteger)
    || r.length < 1 || r.length > LIMITS.run)) throw new Error('Protected runs must be bounded whole-cell runs.');
  for (const c of clearFootprint(policy.protectedRuns ?? [], parent.cells)) protectedCells.add(cellKey(c));
  // Every protected address is parent-owned, hence playable. Clipping a
  // crossing footprint to these cells gives exactly its protected intersection.
  const protectedAddresses = parent.cells.filter(c => protectedCells.has(cellKey(c)));
  const blockers = policy.blockers ?? [];
  if (!Array.isArray(blockers) || blockers.some(s => !validShape(s))) throw new Error('Declared geometry must contain valid collision shapes.');

  const partition = (accepted: PatchOffer[]): Omit<PreparedDelegation, 'rejected'> => {
    // With no handoff the canonical owner already has its original margins,
    // hints and portal promise. Avoid constructing and validating it again.
    if (!accepted.length) {
      if (blockers.length) {
        const fill = createFillMask(parent);
        if (blockers.some(s => !fill.contains(s))) throw new InfeasiblePatch('Patch ownership or crossing clearance conflicts with declared parent geometry.');
      }
      return { retained: structuredClone(parent), children: [], crossings: [] };
    }
    const given = new Set(accepted.flatMap(o => o.cells.map(cellKey)));
    const retainedCells = parent.cells.filter(c => !given.has(cellKey(c)));
    if (!retainedCells.length) throw new InfeasiblePatch('Complete-region handoff belongs to terminal empty execution, not patch preparation.');
    try { checkedRegionCells(retainedCells); } catch { throw new InfeasiblePatch('Patch disconnects retained ownership.'); }
    // Crossing feasibility needs ownership and inherited portals only. Defer
    // zones, hints and fill context until every seam has a compatible crossing.
    const local = [{ id: parent.id, cells: retainedCells, cellSize: parent.cellSize, portals: [] as Portal[] },
      ...accepted.map(o => ({ id: `${parent.id}/delegate/${encodeURIComponent(o.key)}`, cells: o.cells,
        cellSize: parent.cellSize, portals: [] as Portal[] }))];
    const ownerAt = new Map(local.flatMap(b => b.cells.map(c => [cellKey(c), b.id] as const)));
    for (const portal of parent.portals) {
      const owners = new Set(insideCells(portal, owned).map(c => ownerAt.get(cellKey(c))!));
      if (owners.size !== 1) throw new InfeasiblePatch(`External portal ${portal.id} cannot be split.`);
      const id = [...owners][0]!;
      if (policy.externalPortals !== 'whole-child' && id !== parent.id) throw new InfeasiblePatch(`External portal ${portal.id} must remain retained under this policy.`);
      local.find(b => b.id === id)!.portals.push(structuredClone(portal));
    }
    const crossings: BriefCrossing[] = [];
    const radius = hunterClearance(parent.cellSize);
    let mask: ReturnType<typeof createRegionMask> | undefined;
    const width = Math.ceil(2 * radius / parent.cellSize);
    for (const seam of boundaryRuns(local)) {
      let selected: Portal | undefined;
      for (const run of [...seam.runs].sort((a, b) => b.length - a.length || a.axis.localeCompare(b.axis) || a.y - b.y || a.x - b.x)) {
        if (run.length < width) continue;
        const offset = Math.floor((run.length - width) / 2);
        const crossing = { axis: run.axis, x: run.x + (run.axis === 'h' ? offset : 0), y: run.y + (run.axis === 'v' ? offset : 0), length: width };
        const portal: Portal = { ...crossing, id: `${parent.id}/interface/${JSON.stringify([seam.a, seam.b, crossing.axis, crossing.x, crossing.y, crossing.length])}` };
        if (parent.portals.some(p => p.id === portal.id)) throw new Error('Generated crossing identity collides with inherited portal.');
        if (protectedAddresses.length && clearFootprint([portal], protectedAddresses).length) continue;
        const playableMask = mask ??= createRegionMask({ cells: [...parent.cells, ...parent.clearCells!], cellSize: parent.cellSize });
        const owner = local.find(b => b.id === seam.a)!;
        const stands = portalStands({ ...owner, portals: [portal] })[0]!.points;
        if (!stands.length || !stands.every((p, i) => travelClear(playableMask, blockers, p, stands[Math.max(0, i - 1)]!, radius))) continue;
        selected = portal; break;
      }
      if (!selected) throw new InfeasiblePatch(`No compatible hunter crossing between ${seam.a} and ${seam.b}.`);
      local.find(b => b.id === seam.a)!.portals.push(selected);
      local.find(b => b.id === seam.b)!.portals.push(structuredClone(selected));
      crossings.push({ a: seam.a, b: seam.b, portal: selected });
    }
    const complete = local.map((part, i) => ({ ...localBrief(parent, part.cells, i ? accepted[i - 1] : undefined), portals: part.portals }));
    const briefs = finishPartition(parent, complete, message => new InfeasiblePatch(message), briefs => {
      if (blockers.length) {
        const retainedFill = createFillMask(briefs[0]!);
        if (blockers.some(s => !retainedFill.contains(s))) throw new InfeasiblePatch('Patch ownership or crossing clearance conflicts with declared parent geometry.');
      }
    });
    for (let i = 0; i < accepted.length; i++) {
      const reason = policy.receiving(structuredClone(briefs[i + 1]!), structuredClone(accepted[i]!));
      if (reason !== null) {
        if (typeof reason !== 'string' || !reason) throw new Error('Receiving policy must return null or a nonempty infeasibility reason.');
        throw new InfeasiblePatch(`Receiving builder for ${accepted[i]!.key}: ${reason}`);
      }
    }
    return { retained: briefs[0]!, children: accepted.map((o, i) => ({ key: o.key, brief: briefs[i + 1]! })), crossings };
  };
  const accepted: PatchOffer[] = [], rejected: PatchRejection[] = [];
  let prepared = partition(accepted);
  for (const offer of normalized) {
    if (offer.cells.some(c => protectedCells.has(cellKey(c)))) { rejected.push({ key: offer.key, reason: 'Patch contains declared protected cells.' }); continue; }
    try { const next = partition([...accepted, offer]); accepted.push(offer); prepared = next; }
    catch (error) {
      if (!(error instanceof InfeasiblePatch)) throw error;
      rejected.push({ key: offer.key, reason: error.message });
    }
  }
  return { ...prepared, rejected };
}
