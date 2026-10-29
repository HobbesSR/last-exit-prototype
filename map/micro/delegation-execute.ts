import { cellKey, compareCells } from '../kernel/cell.ts';
import type { RegionBrief } from '../kernel/contract.ts';
import { canonicalDelegationBrief, canonicalPreparedDelegationBrief, prepareCanonicalDelegation, prepareCanonicalInitialPartition } from './delegation.ts';
import type { PatchOffer, PatchPreparationPolicy, PreparedDelegation } from './delegation.ts';
import type { BuildingObserver, BuildingTrace } from './building/trace.ts';
import type { BuiltRegion } from './types.ts';
import { sameDelegationJSON } from './delegation-json.ts';
import { builtRegion } from './result.ts';

/** Physical patch execution is separate from the brief preparation SDK and production registry. */
export const DELEGATION_ALGORITHM_VERSION = 'builder-delegation-1';
export type ExecutionPolicyData = Omit<PatchPreparationPolicy, 'receiving'>;
export interface ExecutionContext {
  /** Current retained interface after the one permitted patch batch. */
  readonly brief: RegionBrief;
  /** Detached hypothetical batch, using this invocation's exact receiver/depth semantics. */
  prepareDelegation(offers: readonly PatchOffer[], policyData?: ExecutionPolicyData): PreparedDelegation;
  delegate(offers: readonly PatchOffer[], policyData?: ExecutionPolicyData): DelegationDispatch;
  /** Abandon this invocation, including previous children and observer events. */
  empty(reason: string): never;
}
export interface ExecutionBuilder {
  version: string;
  build: (brief: RegionBrief, context: ExecutionContext, observe?: BuildingObserver) => BuiltRegion;
  receiving?: (brief: RegionBrief, offer: PatchOffer) => string | null;
}
export type ExecutionRegistry = Readonly<Record<string, ExecutionBuilder>>;
export interface DelegationDispatch { prepared: PreparedDelegation; children: DelegationExecutionNode[] }
export type FallbackKind = 'explicit-empty' | 'depth-limit' | 'complete-region' | 'builder-empty';
export interface DelegationExecutionNode {
  version: typeof DELEGATION_ALGORITHM_VERSION;
  input: RegionBrief;
  depth: number;
  requestedBuilder: string;
  actualBuilder: string;
  builderVersion: string;
  retained: BuiltRegion;
  offers?: PatchOffer[];
  policyData?: ExecutionPolicyData;
  preparation?: PreparedDelegation;
  children?: DelegationExecutionNode[];
  /** A whole-region replacement or terminal depth fallback. */
  fallbackReason?: string;
  /** Semantic stopping condition, separate from a builder's free-form reason. */
  fallbackKind?: FallbackKind;
  /** Buffered local observer events; absent from flattened geometry. */
  observerEvents?: BuildingTrace[];
  /** Every invoked or consulted implementation version, including rejected receivers. */
  registryVersions?: Record<string, string>;
  /** Present on the root, whose initial depth is zero. */
  maxDepth?: number;
}
export interface ExecutionOptions { maxDepth?: number; observe?: BuildingObserver }
/** Initial decomposition has child owners only, with no retained builder invocation. */
export interface DelegationPartitionExecution { input: RegionBrief; children: DelegationExecutionNode[] }

class EmptyHandoff {
  readonly reason: string;
  readonly kind: FallbackKind;
  constructor(reason: string, kind: FallbackKind = 'builder-empty') { this.reason = reason; this.kind = kind; }
}
const emptyResult = (brief: RegionBrief): BuiltRegion => builtRegion(brief, [], []);
const emptyNode = (input: RegionBrief, depth: number, reason: string, kind: FallbackKind): DelegationExecutionNode => ({
  version: DELEGATION_ALGORITHM_VERSION, input: structuredClone(input), depth,
  requestedBuilder: input.type, actualBuilder: 'empty', builderVersion: DELEGATION_ALGORITHM_VERSION,
  retained: emptyResult(input), fallbackReason: reason, fallbackKind: kind,
});
function completeOffer(input: RegionBrief, offer: PatchOffer): boolean {
  if (!Array.isArray(offer.cells) || offer.cells.length !== input.cells.length) return false;
  const owned = new Set(input.cells.map(cellKey));
  return Array.isArray(offer.cells) && offer.cells.length === input.cells.length
    && new Set(offer.cells.map(cellKey)).size === input.cells.length
    && offer.cells.every(c => owned.has(cellKey(c)));
}
function prefixed(label: string, prefix: string): string { return prefix ? `${prefix}/${label}` : label; }

/** Dispatch owns execution only; patch preparation and initial planning supply its partition. */
function executionDispatcher(registry: ExecutionRegistry, maxDepth: number) {
  const registryVersions: Record<string, string> = {};
  const remember = (type: string): ExecutionBuilder => {
    if (!Object.hasOwn(registry, type)) throw new Error(`Unknown execution builder ${type}.`);
    const entry = registry[type]!;
    if (!entry || typeof entry.build !== 'function' || typeof entry.version !== 'string' || !entry.version)
      throw new Error(`Invalid execution builder ${type}.`);
    Object.defineProperty(registryVersions, type, { value: entry.version, enumerable: true, writable: true, configurable: true });
    return entry;
  };
  function dispatch(partition: readonly RegionBrief[], depth: number): DelegationExecutionNode[] {
    return partition.map(brief => {
      if (depth > 0 && brief.type !== 'empty' && depth <= maxDepth) remember(brief.type);
      return depth > maxDepth && brief.type !== 'empty'
        ? emptyNode(brief, depth, 'depth-limit', 'depth-limit')
        : run(brief, depth);
    });
  }
  function run(brief: RegionBrief, depth: number): DelegationExecutionNode {
    if (brief.type === 'empty') return emptyNode(brief, depth, 'explicit-empty', 'explicit-empty');
    const entry = remember(brief.type);
    // `brief` is already executor-owned: the root was canonicalized and each
    // child was freshly prepared. Only clones reach builders, getters or policies.
    const inputBrief = brief;
    let current = brief, dispatched: DelegationDispatch | undefined;
    let offers: PatchOffer[] | undefined, policyData: ExecutionPolicyData | undefined;
    let terminal: EmptyHandoff | undefined;
    const events: BuildingTrace[] = [];
    const prepare = (requested: readonly PatchOffer[], policy: ExecutionPolicyData = {}) => prepareCanonicalDelegation(brief, requested, {
      ...policy,
      receiving(child, offer) {
        if (depth >= maxDepth || offer.type === 'empty') return null;
        const receiver = remember(offer.type).receiving;
        return receiver ? receiver(child, offer) : null;
      },
    });
    const context: ExecutionContext = {
      get brief() { return structuredClone(current); },
      prepareDelegation(requested, policy = {}) {
        if (terminal) throw terminal;
        if (dispatched || offers) throw new Error('Cannot prepare after a delegation batch.');
        return structuredClone(prepare(structuredClone(requested), structuredClone(policy)));
      },
      delegate(requested, policy = {}) {
        if (terminal) throw terminal;
        if (dispatched || offers) throw new Error('A builder may delegate one patch batch per invocation.');
        if (!Array.isArray(requested)) throw new Error('Delegation offers must be an array.');
        offers = structuredClone(requested);
        policyData = structuredClone(policy);
        // Let preparation validate the complete offer's ordinary input and policy. The
        // only special outcome is whole-region empty replacement after validation.
        const prepared = prepare(offers, policyData);
        const full = offers.filter(o => completeOffer(brief, o));
        offers.sort((a, b) => a.key.localeCompare(b.key));
        for (const offered of offers) {
          offered.cells.sort(compareCells);
          if (offered.reasonTags) offered.reasonTags = [...new Set(offered.reasonTags)].sort();
        }
        if (full.length === 1 && offers.length === 1 && full[0]!.type === 'empty') {
          terminal = new EmptyHandoff('complete-region', 'complete-region');
          throw terminal;
        }
        // Preparation reports a whole content offer as an ordinary infeasible patch.
        // It never dispatches it, and the builder can still use the retained region.
        const children = dispatch(prepared.children.map(child => child.brief), depth + 1);
        current = prepared.retained;
        dispatched = { prepared, children };
        return structuredClone(dispatched);
      },
      empty(reason) {
        if (terminal) throw terminal;
        if (typeof reason !== 'string' || !reason) throw new Error('Empty fallback needs a nonempty reason.');
        terminal = new EmptyHandoff(reason);
        throw terminal;
      },
    };
    let retained: BuiltRegion;
    try {
      retained = entry.build(structuredClone(brief), context, trace => events.push(structuredClone(trace)));
      // Catching the control signal inside a builder cannot cancel its terminal decision.
      if (terminal) throw terminal;
    }
    catch (error) {
      if (!(error instanceof EmptyHandoff)) throw error;
      const abandoned = emptyNode(inputBrief, depth, error.reason, error.kind);
      if (offers) {
        abandoned.offers = offers;
        abandoned.policyData = policyData!;
        if (dispatched) { abandoned.preparation = dispatched.prepared; abandoned.children = dispatched.children; }
      }
      return abandoned;
    }
    if (!retained || retained.version !== 'region-2' || !retained.brief
      || !sameDelegationJSON(retained.brief, current))
      throw new Error(`Builder ${brief.type} must return a result for its retained brief.`);
    const node: DelegationExecutionNode = {
      version: DELEGATION_ALGORITHM_VERSION, input: inputBrief, depth,
      requestedBuilder: brief.type, actualBuilder: brief.type, builderVersion: entry.version,
      retained: structuredClone(retained), observerEvents: events,
    };
    if (offers) { node.offers = offers; node.policyData = policyData!; node.preparation = dispatched!.prepared; node.children = dispatched!.children; }
    return node;
  }
  return { dispatch, registryVersions };
}

/** Initial decomposition invokes this once per initial brief; its depth starts at zero. */
export function executeDelegation(input: RegionBrief, registry: ExecutionRegistry, options: ExecutionOptions = {}): DelegationExecutionNode {
  return executeOwnedDelegation(input, registry, options, false);
}

/** Only the immediate partition dispatch path may reuse its checked cell ownership. */
function executeOwnedDelegation(input: RegionBrief, registry: ExecutionRegistry, options: ExecutionOptions, checkedCells: boolean): DelegationExecutionNode {
  const maxDepth = options.maxDepth ?? 3;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new Error('Maximum delegation depth must be a nonnegative integer.');
  const { dispatch, registryVersions } = executionDispatcher(registry, maxDepth);
  const canonicalInput = checkedCells ? canonicalPreparedDelegationBrief(input) : canonicalDelegationBrief(input);
  const result = dispatch([canonicalInput], 0)[0]!;
  result.registryVersions = registryVersions;
  result.maxDepth = maxDepth;
  if (options.observe) visitEvents(result, options.observe);
  return result;
}

/**
 * Prepare and dispatch a planner-authored initial partition in planner order, without
 * patch placement or receiving checks. IDs, seeds and interfaces belong to the planner;
 * preparation only inherits margins and validates the partition, so an unprepared
 * partition can never execute. Each child starts at depth zero and remains an
 * independently recoverable root.
 */
export function dispatchDelegationPartition(input: RegionBrief, partition: readonly RegionBrief[],
  registry: ExecutionRegistry, options: ExecutionOptions = {}): DelegationPartitionExecution {
  const canonicalInput = canonicalDelegationBrief(input);
  const prepared = prepareCanonicalInitialPartition(canonicalInput, partition);
  const { observe, ...executionOptions } = options;
  const children = prepared.map(brief => executeOwnedDelegation(brief, registry, executionOptions, true));
  if (observe) for (const child of children) visitEvents(child, observe, child.input.id);
  return { input: canonicalInput, children };
}

function visitEvents(node: DelegationExecutionNode, observe: BuildingObserver, prefix = ''): void {
  if (node.actualBuilder === 'empty') return;
  for (const event of node.observerEvents ?? []) observe({ ...structuredClone(event), label: prefixed(event.label, prefix) });
  for (const child of node.children ?? []) visitEvents(child, observe, child.input.id);
}

/** Actual output owners, including terminal empty children, in stable tree order. */
export function executionLeaves(node: DelegationExecutionNode): BuiltRegion[] {
  if (node.actualBuilder === 'empty') return [node.retained];
  return [node.retained, ...(node.children ?? []).flatMap(executionLeaves)];
}

/** Runtime view from saved generation objects; it never needs today's registry. */
export function flattenDelegationResult(node: DelegationExecutionNode): BuiltRegion {
  return flattenExecution(node.input, [{ node, prefix: '' }]);
}

/** Gather initial owners using the same absolute labels and manifest as patch children. */
export function flattenDelegationPartition(partition: DelegationPartitionExecution): BuiltRegion {
  return flattenExecution(partition.input, partition.children.map(node => ({ node, prefix: node.input.id })));
}

function flattenExecution(input: RegionBrief, roots: readonly { node: DelegationExecutionNode; prefix: string }[]): BuiltRegion {
  const elements: BuiltRegion['elements'] = [], coreElements: BuiltRegion['coreElements'] = [], loot: BuiltRegion['loot'] = [];
  const additive = ['structures', 'obstacles', 'gates', 'attempted', 'rejected'];
  const counts: Record<string, number> = Object.fromEntries(additive.map(k => [k, 0]));
  function gather(at: DelegationExecutionNode, prefix: string): void {
    for (const element of at.retained.elements) elements.push({ ...structuredClone(element), label: prefixed(element.label, prefix) });
    coreElements.push(...structuredClone(at.retained.coreElements));
    loot.push(...structuredClone(at.retained.loot));
    for (const key of additive) if (Number.isFinite(at.retained.manifest[key])) counts[key]! += at.retained.manifest[key]!;
    if (at.actualBuilder !== 'empty') for (const child of at.children ?? []) gather(child, child.input.id);
  }
  for (const { node, prefix } of roots) gather(node, prefix);
  return { version: 'region-2', brief: structuredClone(input), elements, coreElements, loot,
    manifest: { cells: input.cells.length, structures: counts.structures!, obstacles: counts.obstacles!,
      gates: counts.gates!, loot: loot.length, coreElements: coreElements.length,
      ...(counts.attempted ? { attempted: counts.attempted } : {}),
      ...(counts.rejected ? { rejected: counts.rejected } : {}) } };
}
