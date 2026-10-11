import { prepareDelegation, validateBriefPartition } from './delegation.ts';
import type { PatchRejection } from './delegation.ts';
import { DELEGATION_ALGORITHM_VERSION, executeDelegation, flattenDelegationResult } from './delegation-execute.ts';
import type { DelegationExecutionNode, ExecutionRegistry } from './delegation-execute.ts';
import type { BuiltRegion } from './types.ts';
import { delegationJSON as json, sameDelegationJSON as same } from './delegation-json.ts';

export const DELEGATION_SNAPSHOT_VERSION = 'builder-delegation-snapshot-1';
/** Preparation is a derived view; only accepted keys and actual rejection reasons are saved. */
export type SavedDelegationNode = Omit<DelegationExecutionNode, 'preparation' | 'children' | 'retained'> & {
  retained?: BuiltRegion;
  decisions?: { acceptedKeys: string[]; rejected: PatchRejection[] };
  children?: SavedDelegationNode[];
};
export interface DelegationSnapshot {
  version: typeof DELEGATION_SNAPSHOT_VERSION;
  algorithmVersion: typeof DELEGATION_ALGORITHM_VERSION;
  generation: SavedDelegationNode;
}

export function saveDelegationSnapshot(node: DelegationExecutionNode, options: { omitResults?: boolean } = {}): DelegationSnapshot {
  function save(at: DelegationExecutionNode): SavedDelegationNode {
    const { preparation, children, retained, ...authored } = structuredClone(at);
    return { ...authored,
      ...(!options.omitResults ? { retained } : {}),
      ...(preparation ? { decisions: { acceptedKeys: preparation.children.map(c => c.key), rejected: preparation.rejected } } : {}),
      ...(children ? { children: children.map(save) } : {}),
    };
  }
  const snapshot: DelegationSnapshot = { version: DELEGATION_SNAPSHOT_VERSION, algorithmVersion: DELEGATION_ALGORITHM_VERSION, generation: save(node) };
  // Check that saving cannot lose semantic input to JSON encoding.
  json(snapshot);
  return snapshot;
}

/** Recover a fully saved object without dispatching any builder, including abandoned attempts. */
function recover(saved: SavedDelegationNode, expectedDepth = 0): DelegationExecutionNode {
  if (!saved || saved.version !== DELEGATION_ALGORITHM_VERSION || saved.depth !== expectedDepth)
    throw new Error('Invalid delegation generation version or depth.');
  const { decisions, children, retained, ...authored } = structuredClone(saved);
  if (!retained) throw new Error(`Missing saved result for ${saved.input?.id}.`);
  if (retained.version !== 'region-2' || !Array.isArray(retained.elements) || !Array.isArray(retained.loot) || !Array.isArray(retained.coreElements))
    throw new Error(`Invalid saved result for ${saved.input?.id}.`);
  // The SDK checks complete ownership/interface input even for terminal empty.
  prepareDelegation(saved.input, [], { receiving: () => null });
  if (saved.offers) prepareDelegation(saved.input, saved.offers, { ...saved.policyData, receiving: () => null });
  if (saved.requestedBuilder !== saved.input.type || typeof saved.builderVersion !== 'string' || !saved.builderVersion)
    throw new Error('Invalid saved builder provenance.');
  const node: DelegationExecutionNode = { ...authored, retained };
  if (children) node.children = children.map(child => recover(child, expectedDepth + 1));
  if (decisions) {
    if (!Array.isArray(saved.offers) || !Array.isArray(decisions.acceptedKeys) || !Array.isArray(decisions.rejected)
      || new Set(decisions.acceptedKeys).size !== decisions.acceptedKeys.length)
      throw new Error('Invalid saved delegation decisions.');
    const selected = new Set(decisions.acceptedKeys);
    const accepted = saved.offers.filter(offer => selected.has(offer.key));
    if (accepted.length !== selected.size) throw new Error('Saved accepted patch keys do not match requests.');
    const prepared = prepareDelegation(saved.input, accepted, { ...saved.policyData, receiving: () => null });
    if (prepared.rejected.length || !same(prepared.children.map(c => c.key), decisions.acceptedKeys))
      throw new Error('Saved accepted patches cannot reconstruct their interfaces.');
    const rejectedKeys = decisions.rejected.map(r => r.key);
    if (new Set([...rejectedKeys, ...selected]).size !== saved.offers.length
      || rejectedKeys.some(k => !saved.offers!.some(o => o.key === k))
      || decisions.rejected.some(r => typeof r.reason !== 'string' || !r.reason))
      throw new Error('Saved patch outcomes do not account for every request.');
    prepared.rejected = decisions.rejected;
    node.preparation = prepared;
    if (!same(prepared.children.map(c => c.brief), (node.children ?? []).map(c => c.input)))
      throw new Error('Saved child inputs disagree with reconstructed interfaces.');
  } else if (children?.length) throw new Error('Saved children need patch decisions.');
  const expectedBrief = node.actualBuilder === 'empty' ? node.input : node.preparation?.retained ?? node.input;
  if (!same(retained.brief, expectedBrief)) throw new Error('Saved retained result disagrees with its owning interface.');
  if (node.actualBuilder === 'empty') {
    const emptyManifest = { cells: node.input.cells.length, structures: 0, obstacles: 0, gates: 0, loot: 0, coreElements: 0 };
    if (typeof node.fallbackReason !== 'string' || !node.fallbackReason || retained.elements.length || retained.loot.length || retained.coreElements.length
      || node.builderVersion !== DELEGATION_ALGORITHM_VERSION || !same(retained.manifest, emptyManifest)
      || !['explicit-empty', 'depth-limit', 'complete-region', 'builder-empty'].includes(node.fallbackKind ?? ''))
      throw new Error('Terminal empty results must remain empty.');
    if (node.fallbackKind === 'complete-region'
      && (node.offers?.length !== 1 || node.offers[0]!.type !== 'empty' || node.offers[0]!.cells.length !== node.input.cells.length || decisions))
      throw new Error('Complete-region fallback needs a whole-footprint empty offer.');
    if (node.fallbackKind === 'explicit-empty' && (node.requestedBuilder !== 'empty' || node.offers || node.children))
      throw new Error('Explicit empty provenance disagrees with the recorded input.');
  } else if (node.actualBuilder !== node.requestedBuilder || node.fallbackKind || node.fallbackReason)
    throw new Error('Saved content builder provenance changed.');
  // Prove each local interface graph. Descendants may touch an ancestor's
  // neighbor without acquiring a new direct portal to that neighbor; their
  // inherited promise composes through the retained owner at each level.
  const local = node.actualBuilder === 'empty' ? [node.retained.brief]
    : [node.retained.brief, ...(node.children ?? []).map(child => child.input)];
  const errors = validateBriefPartition(node.input, local);
  if (errors.length) throw new Error(`Saved delegation ownership: ${errors.join(' ')}`);
  return node;
}

export function readDelegationSnapshot(snapshot: DelegationSnapshot, registry?: ExecutionRegistry): DelegationExecutionNode {
  if (!snapshot || snapshot.version !== DELEGATION_SNAPSHOT_VERSION)
    throw new Error(`Unsupported delegation snapshot version ${snapshot?.version}. Expected ${DELEGATION_SNAPSHOT_VERSION}.`);
  if (snapshot.algorithmVersion !== DELEGATION_ALGORITHM_VERSION)
    throw new Error(`Delegation algorithm version ${snapshot.algorithmVersion} does not match ${DELEGATION_ALGORITHM_VERSION}.`);
  json(snapshot);
  const root = snapshot.generation;
  if (!root || !Number.isSafeInteger(root.maxDepth) || root.maxDepth! < 0 || !root.registryVersions)
    throw new Error('Delegation snapshot needs execution settings and builder versions.');
  if (Object.values(root.registryVersions).some(version => typeof version !== 'string' || !version))
    throw new Error('Delegation snapshot needs named nonempty builder versions.');
  function versions(at: SavedDelegationNode): void {
    if (at.requestedBuilder !== 'empty' && at.fallbackKind !== 'depth-limit') {
      const version = root.registryVersions![at.requestedBuilder];
      if (!Object.hasOwn(root.registryVersions!, at.requestedBuilder) || !version
        || at.actualBuilder !== 'empty' && version !== at.builderVersion)
        throw new Error(`Delegation snapshot is missing the recorded version for builder ${at.requestedBuilder}.`);
    }
    if (at.depth > root.maxDepth! && at.actualBuilder !== 'empty')
      throw new Error('Saved content builder exceeds maximum delegation depth.');
    if (at.fallbackKind === 'depth-limit' && (at.depth !== root.maxDepth! + 1 || at.requestedBuilder === 'empty'))
      throw new Error('Saved depth fallback disagrees with execution settings.');
    for (const child of at.children ?? []) versions(child);
  }
  versions(root);
  function missing(at: SavedDelegationNode): boolean { return !at.retained || (at.children ?? []).some(missing); }
  if (!missing(root)) return recover(root);
  if (!registry) throw new Error('Omitted delegation results require the recorded builder registry.');
  for (const [name, version] of Object.entries(root.registryVersions)) {
    if (!Object.hasOwn(registry, name) || registry[name]!.version !== version)
      throw new Error(`Delegation builder ${name} version ${version} does not match ${registry[name]?.version ?? 'missing'}.`);
  }
  const rebuilt = executeDelegation(root.input, registry, { maxDepth: root.maxDepth! });
  // Authored decisions are immutable evidence, even when geometry was omitted.
  const wanted = saveDelegationSnapshot(rebuilt, { omitResults: true });
  const supplied = structuredClone(snapshot);
  function omit(at: SavedDelegationNode): void { delete at.retained; for (const child of at.children ?? []) omit(child); }
  omit(supplied.generation);
  if (!same(wanted, supplied)) throw new Error('Regenerated delegation decisions differ from the recorded snapshot.');
  function checkKept(at: SavedDelegationNode, built: DelegationExecutionNode): void {
    if (at.retained && !same(at.retained, built.retained)) throw new Error(`Regenerated result differs for ${at.input.id}.`);
    (at.children ?? []).forEach((child, index) => checkKept(child, built.children![index]!));
  }
  checkKept(root, rebuilt);
  return recover(saveDelegationSnapshot(rebuilt).generation);
}

/** The ordinary region-2 runtime view is derived from the owning saved objects. */
export function delegationSnapshotResult(snapshot: DelegationSnapshot, registry?: ExecutionRegistry): BuiltRegion {
  return flattenDelegationResult(readDelegationSnapshot(snapshot, registry));
}
