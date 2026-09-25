import { allocateCandidates } from './allocation.ts';
import { cellKey, connectedComponents } from './analysis.ts';
import { createRegionContext } from './context.ts';
import { EXAMPLE_GENERATORS, planExample } from './example.ts';
import { buildInterfaces } from './interfaces.ts';
import { validateDecompositionPlan } from './validate.ts';
import type { AllocationPolicy, CandidatePiece, DecompositionPlan, RegionContext, RegionContextInput } from './types.ts';
import type { Cell } from '../types.ts';

export type ExplorationObjective = 'balanced' | 'rooms' | 'preserve';
export type ExplorationSource = 'root' | 'piece' | 'residual' | 'reserved' | 'forbidden';

export interface ExplorationNode {
  id: string;
  cells: Cell[];
  role: string;
  generator?: string;
  source: ExplorationSource;
  children: ExplorationNode[];
  plan?: DecompositionPlan;
  stopReason?: string;
}
export interface ExplorationAlternative {
  id: string;
  root: ExplorationNode;
  score: number;
  scoreComponents: Record<string, number>;
  metrics: Record<string, number>;
}
export interface DecompositionExploration {
  version: 'decomposition-exploration-1';
  objective: ExplorationObjective;
  alternatives: ExplorationAlternative[];
  search: { expanded: number; limit: number; budgetExhausted: boolean; optimal: false };
}
export interface ExplorationOptions {
  objective?: ExplorationObjective;
  maxDepth?: number;
  beamWidth?: number;
  maxExpansions?: number;
}

interface SearchTree { root: ExplorationNode; serial: number; expandedLeaves: Set<string> }

const copy = (cells: readonly Cell[]) => cells.map(c => ({ x: c.x, y: c.y }));
const keys = (cells: readonly Cell[]) => new Set(cells.map(cellKey));

function optionsFor(options: ExplorationOptions) {
  const objective = options.objective ?? 'balanced';
  const maxDepth = options.maxDepth ?? 2, beamWidth = options.beamWidth ?? 4, maxExpansions = options.maxExpansions ?? 24;
  if (!['balanced', 'rooms', 'preserve'].includes(objective)) throw new Error('Unknown exploration objective.');
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 3) throw new Error('maxDepth must be 1..3.');
  if (!Number.isInteger(beamWidth) || beamWidth < 1 || beamWidth > 8) throw new Error('beamWidth must be 1..8.');
  if (!Number.isInteger(maxExpansions) || maxExpansions < 1 || maxExpansions > 64) throw new Error('maxExpansions must be 1..64.');
  return { objective: objective as ExplorationObjective, maxDepth, beamWidth, maxExpansions };
}

function childNodes(plan: DecompositionPlan, parent: ExplorationNode): ExplorationNode[] {
  const parts = [
    ...plan.pieces.map(piece => ({ id: piece.id, cells: piece.cells, role: piece.role, generator: piece.generator, source: 'piece' as const })),
    ...plan.residuals.map(residual => ({ id: residual.id, cells: residual.cells, role: residual.role, source: residual.role as ExplorationSource })),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const parentKeys = keys(parent.cells), seen = new Set<string>();
  if (parts.length < 2 || parts.some(part => !part.cells.length || part.cells.length >= parent.cells.length)) throw new Error('Exploration requires strict geometric progress.');
  for (const part of parts) for (const cell of part.cells) {
    const key = cellKey(cell); if (!parentKeys.has(key) || seen.has(key)) throw new Error('Local plan is not a partition of its parent.');
    seen.add(key);
  }
  if (seen.size !== parentKeys.size) throw new Error('Local plan drops parent cells.');
  return parts.map(part => ({ id: `${parent.id}/${part.id}`, cells: copy(part.cells), role: part.role, ...('generator' in part && part.generator ? { generator: part.generator } : {}), source: part.source,
    children: [], stopReason: part.source === 'reserved' || part.source === 'forbidden' ? 'constrained terminal' : 'retained terminal choice' }));
}

function planPolicies(input: RegionContextInput): DecompositionPlan[] {
  const context = createRegionContext(input), results: DecompositionPlan[] = [];
  const add = (plan: DecompositionPlan) => {
    if (!validateDecompositionPlan(plan, EXAMPLE_GENERATORS).length && plan.residuals.length + plan.pieces.length >= 2) results.push(plan);
  };
  add(planExample(structuredClone(context.input) as RegionContextInput));
  // This intentionally coarse policy offers an alternative to high-piece decompositions.
  add(planExample(structuredClone(context.input) as RegionContextInput, { piecePenalty: 24, residualComponentPenalty: 2 }));
  const unavailable = new Set([...(context.input.reserved || []), ...(context.input.forbidden || [])].map(cellKey));
  const available = context.input.cells.filter(cell => !unavailable.has(cellKey(cell)));
  const analysis = context.analyze(available);
  if (analysis.rectangularity === 1 && connectedComponents(available).length === 1) {
    const candidates: CandidatePiece[] = [];
    for (const axis of ['x', 'y'] as const) {
      const length = axis === 'x' ? analysis.bounds.w : analysis.bounds.h;
      if (length < 6) continue;
      const midpoint = (axis === 'x' ? analysis.bounds.x : analysis.bounds.y) + Math.floor(length / 2);
      const halves = [available.filter(c => axis === 'x' ? c.x < midpoint : c.y < midpoint), available.filter(c => axis === 'x' ? c.x >= midpoint : c.y >= midpoint)];
      if (halves.every(part => part.length && part.length < available.length)) halves.forEach((cells, i) => candidates.push({ id: `midpoint-${axis}-${i}`, cells, role: 'room', rationale: `Midpoint ${axis} split offers a room without claiming the whole footprint.` }));
    }
    if (candidates.length) {
      const policy: AllocationPolicy = { beamWidth: 8, maxPieces: 6, maxCandidates: 32, unusedCellPenalty: .2, residualComponentPenalty: 4, smallResidualPenalty: 2, smallResidualArea: 8, piecePenalty: 1, seamRunPenalty: .5, portalWidth: 2 };
      add(allocateCandidates(context, candidates, EXAMPLE_GENERATORS, policy, { strategy: 'exploration-midpoint-splits' }));
    }
  }
  const seen = new Set<string>();
  return results.filter(plan => { const signature = [...plan.pieces.map(p => `p:${p.generator}:${p.cells.map(cellKey).sort().join(';')}`), ...plan.residuals.map(r => `r:${r.role}:${r.cells.map(cellKey).sort().join(';')}`)].sort().join('|'); if (seen.has(signature)) return false; seen.add(signature); return true; });
}

function localInput(parent: RegionContext, node: ExplorationNode): RegionContextInput {
  // Context owns annotation restriction; recursive strategy code does not recreate it.
  return structuredClone(parent.child(node.id, node.cells).input) as RegionContextInput;
}

/** A stopped root still has an explicit, feasible owner; it is never an unassigned winner. */
function wholeOwner(input: RegionContextInput): DecompositionPlan {
  const context = createRegionContext(input), excluded = new Set([...(input.reserved || []), ...(input.forbidden || [])].map(cellKey));
  const available = input.cells.filter(c => !excluded.has(cellKey(c)));
  const candidates: CandidatePiece[] = connectedComponents(available).flatMap((cells, i) => [
    { id: `whole-${i}-utility`, cells, role: 'utility', rationale: 'Stopped exploration retains a feasible generic owner.' },
    { id: `whole-${i}-courtyard`, cells, role: 'courtyard', rationale: 'Stopped exploration may retain an intact hole-bearing owner.' },
  ]).slice(0, 128);
  const policy: AllocationPolicy = { beamWidth: 2, maxPieces: 16, maxCandidates: 128, unusedCellPenalty: 1, residualComponentPenalty: 1, smallResidualPenalty: 0, smallResidualArea: 1, piecePenalty: 0, seamRunPenalty: 0, portalWidth: 2 };
  return allocateCandidates(context, candidates, EXAMPLE_GENERATORS, policy, { strategy: 'exploration-stopped-owner' });
}

function replaceNode(node: ExplorationNode, id: string, replacement: ExplorationNode): ExplorationNode {
  if (node.id === id) return replacement;
  return { ...node, cells: copy(node.cells), children: node.children.map(child => replaceNode(child, id, replacement)), ...(node.plan ? { plan: structuredClone(node.plan) } : {}) };
}
function leaves(node: ExplorationNode, depth = 0): Array<{ node: ExplorationNode; depth: number }> {
  return node.children.length ? node.children.flatMap(child => leaves(child, depth + 1)) : [{ node, depth }];
}

function evaluate(root: ExplorationNode, objective: ExplorationObjective, rootHoles: number): Omit<ExplorationAlternative, 'id' | 'root'> {
  const allLeaves = leaves(root).map(item => item.node), total = root.cells.length;
  const pieces = allLeaves.filter(n => !!n.generator && (n.source === 'root' || n.source === 'piece')), residuals = allLeaves.filter(n => n.source === 'residual');
  // A room at the ~40-cell target contributes positively; an absent room is neutral,
  // so the rooms preset can select an actual split instead of an intact generic owner.
  const rooms = pieces.filter(n => n.role === 'room'), roomCloseness = rooms.reduce((sum, room) => sum + 40 - Math.abs(room.cells.length - 40), 0);
  const generatorFitness = pieces.reduce((sum, piece) => sum + (piece.generator === 'rectangular-room' ? piece.cells.length * 1.5 : piece.generator === 'courtyard-ring' ? piece.cells.length * 1.6 + 20 : piece.generator === 'circulation-strip' ? piece.cells.length * 1.1 : piece.cells.length * .65), 0);
  const covered = pieces.reduce((sum, n) => sum + n.cells.length, 0), residualCells = residuals.reduce((sum, n) => sum + n.cells.length, 0);
  const maxIntact = Math.max(...allLeaves.map(n => n.cells.length));
  const holeIntact = rootHoles && allLeaves.some(n => n.cells.length === root.cells.length) ? rootHoles : 0;
  const seams = buildInterfaces(allLeaves.map(n => ({ id: n.id, cells: n.cells }))).reduce((sum, item) => sum + item.length, 0), residualQuality = -residuals.length * 8 - residualCells * .08;
  const metrics = { generatorFitness, coverage: covered / total, roomTargetCloseness: roomCloseness, pieceComplexity: pieces.length, seams, residualQuality, preservedHoles: holeIntact, largestIntactArea: maxIntact };
  const scoreComponents = objective === 'rooms'
    ? { generatorFitness: generatorFitness * .2, coverage: metrics.coverage * 20, roomTargetCloseness: roomCloseness * 2, pieceComplexity: -pieces.length * .5, seams: -seams * .25, residualQuality: residualQuality * .3, preservedHoles: holeIntact }
    : objective === 'preserve'
      ? { generatorFitness: generatorFitness * .1, coverage: metrics.coverage * 4, roomTargetCloseness: roomCloseness * .05, pieceComplexity: -pieces.length, seams: -seams, residualQuality, preservedHoles: holeIntact * 50, largestIntactArea: maxIntact * .8 }
      : { generatorFitness: generatorFitness * .35, coverage: metrics.coverage * 15, roomTargetCloseness: roomCloseness * .35, pieceComplexity: -pieces.length, seams: -seams * .5, residualQuality, preservedHoles: holeIntact * 12 };
  const normalize = (value: number) => Object.is(value, -0) ? 0 : value;
  return { score: normalize(Object.values(scoreComponents).reduce((sum, n) => sum + n, 0)), scoreComponents: Object.fromEntries(Object.entries(scoreComponents).map(([k, v]) => [k, normalize(v)])), metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, normalize(v)])) };
}

function signature(root: ExplorationNode): string { return leaves(root).map(v => `${v.node.role}:${v.node.source}:${v.node.cells.map(cellKey).sort().join(';')}`).sort().join('|'); }

/** Bounded strategy-level exploration. It is deterministic and deliberately non-optimal. */
export function exploreDecomposition(input: RegionContextInput, options: ExplorationOptions = {}): DecompositionExploration {
  const config = optionsFor(options), parent = createRegionContext(input);
  const owner = wholeOwner(parent.input as RegionContextInput);
  const parts = [...owner.pieces, ...owner.residuals];
  const only = parts.length === 1 ? parts[0] : undefined;
  const initial: ExplorationNode = { id: parent.input.id, cells: copy(parent.input.cells), role: only?.role || 'root', source: 'root', children: [] };
  if (only && 'generator' in only) { initial.generator = only.generator; initial.stopReason = 'retained terminal choice'; }
  else if (only) { initial.source = only.role; initial.stopReason = only.role === 'residual' ? 'unassigned residual; no feasible whole generator' : 'constrained terminal'; }
  else { initial.plan = owner; initial.children = childNodes(owner, initial); }
  const rootHoles = parent.analyze().holes.length;
  const evaluations = new Map<string, ReturnType<typeof evaluate>>();
  const evaluated = (root: ExplorationNode) => {
    const key = signature(root);
    let value = evaluations.get(key);
    if (!value) { value = evaluate(root, config.objective, rootHoles); evaluations.set(key, value); }
    return value;
  };
  let frontier: SearchTree[] = [{ root: initial, serial: 0, expandedLeaves: new Set() }], serial = 1, expanded = 0;
  const planCache = new Map<string, DecompositionPlan[]>();
  while (frontier.length && expanded < config.maxExpansions) {
    const next: SearchTree[] = [];
    let changed = false;
    for (const tree of frontier) {
      next.push(tree); // retaining the stop choice makes truncation explicit and inspectable.
      for (const target of leaves(tree.root)) {
        if (expanded >= config.maxExpansions) break;
        if (target.depth >= config.maxDepth || target.node.source === 'reserved' || target.node.source === 'forbidden' || target.node.cells.length < 2 || tree.expandedLeaves.has(target.node.id)) continue;
        const local = localInput(parent, target.node), cacheKey = `${local.cells.map(cellKey).sort().join(';')}|${(local.reserved || []).map(cellKey).sort().join(';')}|${(local.forbidden || []).map(cellKey).sort().join(';')}`;
        let plans = planCache.get(cacheKey); if (!plans) { plans = planPolicies(local); planCache.set(cacheKey, plans); }
        expanded++;
        for (const plan of plans) try {
          const refined: ExplorationNode = { ...target.node, cells: copy(target.node.cells), plan: structuredClone(plan), children: childNodes(plan, target.node) };
          const visited = new Set(tree.expandedLeaves); visited.add(target.node.id);
          next.push({ root: replaceNode(tree.root, target.node.id, refined), serial: serial++, expandedLeaves: visited }); changed = true;
        } catch { /* Non-progressing allocations remain terminal choices. */ }
        tree.expandedLeaves.add(target.node.id);
      }
    }
    const dedup = new Map<string, SearchTree>();
    for (const tree of next) { const key = `${signature(tree.root)}|${[...tree.expandedLeaves].sort().join(',')}`; if (!dedup.has(key)) dedup.set(key, tree); }
    frontier = [...dedup.values()].sort((a, b) => evaluated(b.root).score - evaluated(a.root).score || a.serial - b.serial).slice(0, config.beamWidth);
    if (!changed) break;
  }
  for (const tree of frontier) for (const item of leaves(tree.root)) if (item.node.source !== 'reserved' && item.node.source !== 'forbidden') item.node.stopReason = item.depth >= config.maxDepth ? 'depth limit' : item.node.stopReason || 'retained terminal choice';
  const finalSeen = new Set<string>();
  frontier = frontier.filter(tree => { const key = signature(tree.root); if (finalSeen.has(key)) return false; finalSeen.add(key); return true; });
  const alternatives = frontier.map((tree, i) => ({ id: `alternative-${i + 1}`, root: tree.root, ...evaluated(tree.root) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  // JSON is the public artifact boundary and canonicalizes negative zero inherited
  // from arithmetic in allocation score components.
  return JSON.parse(JSON.stringify({ version: 'decomposition-exploration-1', objective: config.objective, alternatives,
    search: { expanded, limit: config.maxExpansions, budgetExhausted: expanded >= config.maxExpansions, optimal: false } })) as DecompositionExploration;
}
