import { canonicalCells, cellKey, connectedComponents } from './analysis.ts';
import { buildInterfaces } from './interfaces.ts';
import type { Cell } from '../types.ts';
import type { AllocationPolicy, AssignedPiece, CandidatePiece, DecompositionPlan, GeneratorContract, NeckCut, RegionContext, ResidualRegion } from './types.ts';

interface StateCore { context: RegionContext; cells: readonly Cell[]; index: Map<string, number>; excluded: Set<string> }

/** Forks copy a bounded occupancy bitset and piece list; context and analyses are shared. */
export class DecompositionState {
  readonly #core: StateCore;
  readonly #bits: Uint32Array;
  readonly #pieces: readonly AssignedPiece[];
  constructor(context: RegionContext, core?: StateCore, bits?: Uint32Array, pieces: readonly AssignedPiece[] = []) {
    this.#core = core || { context, cells: context.input.cells, index: new Map(context.input.cells.map((c, i) => [cellKey(c), i])),
      excluded: new Set([...(context.input.reserved || []), ...(context.input.forbidden || [])].map(cellKey)) };
    this.#bits = bits || new Uint32Array(Math.ceil(this.#core.cells.length / 32));
    this.#pieces = pieces;
  }
  get pieces(): AssignedPiece[] { return structuredClone(this.#pieces) as AssignedPiece[]; }
  has(cell: Cell): boolean {
    const i = this.#core.index.get(cellKey(cell));
    return i !== undefined && !!(this.#bits[i >>> 5]! & (1 << (i & 31)));
  }
  canClaim(cells: readonly Cell[]): boolean {
    return cells.length > 0 && cells.every(c => this.#core.index.has(cellKey(c)) && !this.#core.excluded.has(cellKey(c)) && !this.has(c));
  }
  withClaim(piece: AssignedPiece): DecompositionState {
    const cells = canonicalCells(piece.cells);
    if (!piece.id || piece.id.startsWith('@') || this.#pieces.some(p => p.id === piece.id) || !this.canClaim(cells) || connectedComponents(cells).length !== 1) throw new Error('Claim must be a unique, connected, available subset.');
    const bits = this.#bits.slice();
    for (const c of cells) { const i = this.#core.index.get(cellKey(c))!; bits[i >>> 5] = bits[i >>> 5]! | (1 << (i & 31)); }
    const pieces = [...this.#pieces, structuredClone({ ...piece, cells })].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return new DecompositionState(this.#core.context, this.#core, bits, pieces);
  }
  remainingComponents(): Cell[][] { return connectedComponents(this.#core.cells.filter(c => !this.has(c) && !this.#core.excluded.has(cellKey(c)))); }
  residuals(): ResidualRegion[] {
    const result: ResidualRegion[] = this.remainingComponents().map((cells, i) => ({ id: `@residual:${i}`, cells, role: 'residual' }));
    for (const role of ['reserved', 'forbidden'] as const) for (const [i, cells] of connectedComponents(this.#core.context.input[role] || []).entries()) result.push({ id: `@${role}:${i}`, cells, role });
    return result;
  }
}

/** Measurements describe a trial; the caller's policy supplies their importance. */
export function measureState(state: DecompositionState, portalWidth = 2, smallArea = 8) {
  const residuals = state.residuals(), pieces = state.pieces, unclaimed = residuals.filter(r => r.role === 'residual');
  const interfaces = buildInterfaces([...pieces, ...residuals], portalWidth);
  return { residuals, interfaces, unusedCells: unclaimed.reduce((sum, r) => sum + r.cells.length, 0),
    residualComponents: unclaimed.length, smallResidualCells: unclaimed.filter(r => r.cells.length < smallArea).reduce((sum, r) => sum + r.cells.length, 0),
    pieceCount: pieces.length, seamRuns: interfaces.reduce((sum, edge) => sum + edge.runs.length, 0) };
}

export function generatorFitness(context: RegionContext, candidate: CandidatePiece, generator: GeneratorContract) {
  const a = context.analyze(candidate.cells), reasons: string[] = [];
  if (!a.area || a.components.length !== 1) reasons.push('Footprint must be nonempty and connected.');
  if (!generator.roles.includes(candidate.role)) reasons.push(`Role ${candidate.role} is unsupported.`);
  if (a.area < generator.minArea || a.area > generator.maxArea) reasons.push(`Area ${a.area} is outside ${generator.minArea}..${generator.maxArea}.`);
  if (generator.holes === 'none' && a.holes.length || generator.holes === 'one' && a.holes.length !== 1) reasons.push(`Hole count ${a.holes.length} is unsupported.`);
  if (generator.rectangular && a.rectangularity !== 1) reasons.push('Generator requires a rectangle.');
  if (candidate.requiredTags?.some(tag => !generator.tags.includes(tag))) reasons.push('Required generator capability tag is missing.');
  if (generator.feasible) reasons.push(...generator.feasible(a, candidate, context));
  const scores = reasons.length ? {} : generator.utility(a, candidate, context);
  if (Object.values(scores).some(value => !Number.isFinite(value))) throw new Error(`Nonfinite utility from ${generator.id}.`);
  return { feasible: reasons.length === 0, reasons, scores };
}

export function validateAllocationPolicy(policy: AllocationPolicy): void {
  for (const key of ['beamWidth', 'maxPieces', 'maxCandidates'] as const) if (!Number.isInteger(policy[key]) || policy[key] < 1 || policy[key] > ({ beamWidth: 32, maxPieces: 16, maxCandidates: 128 })[key]) throw new Error(`Invalid search bound ${key}.`);
  for (const key of ['unusedCellPenalty', 'residualComponentPenalty', 'smallResidualPenalty', 'smallResidualArea', 'piecePenalty', 'seamRunPenalty', 'portalWidth'] as const) if (!Number.isFinite(policy[key]) || policy[key] < 0) throw new Error(`Invalid policy ${key}.`);
  if (!policy.portalWidth) throw new Error('Portal width must be positive.');
}

export function scoreState(state: DecompositionState, policy: AllocationPolicy) {
  validateAllocationPolicy(policy);
  const m = measureState(state, policy.portalWidth, policy.smallResidualArea);
  const fitness = state.pieces.reduce((sum, p) => sum + Object.values(p.scores).reduce((s, n) => s + n, 0), 0);
  const components = { fitness, unused: -m.unusedCells * policy.unusedCellPenalty, residualComponents: -m.residualComponents * policy.residualComponentPenalty,
    smallResiduals: -m.smallResidualCells * policy.smallResidualPenalty, pieces: -m.pieceCount * policy.piecePenalty, seams: -m.seamRuns * policy.seamRunPenalty };
  const score = Object.values(components).reduce((s, n) => s + n, 0);
  if (!Number.isFinite(score)) throw new Error('Allocation score overflow.');
  return { score, components, ...m };
}

export function allocateCandidates(context: RegionContext, candidates: CandidatePiece[], generators: GeneratorContract[], policy: AllocationPolicy,
  options: { strategy?: string; cuts?: NeckCut[] } = {}): DecompositionPlan {
  validateAllocationPolicy(policy);
  if (!policy.portalWidth || !generators.length || generators.length > 16 || candidates.length > 1024) throw new Error('Invalid allocation input bounds.');
  const generatorIds = new Set<string>();
  for (const g of generators) {
    if (!g.id || generatorIds.has(g.id) || !['none', 'one', 'any'].includes(g.holes) || !Number.isFinite(g.minArea) || !Number.isFinite(g.maxArea) || g.minArea < 1 || g.maxArea < g.minArea) throw new Error('Invalid generator contract.');
    generatorIds.add(g.id);
  }
  const ids = new Set<string>();
  for (const c of candidates) { if (!c.id || c.id.startsWith('@') || ids.has(c.id)) throw new Error('Candidates need unique non-reserved identities.'); ids.add(c.id); }
  const ordered = [...candidates].sort((a, b) => a.id.localeCompare(b.id)), diagnostics: DecompositionPlan['diagnostics'] = [], choices: AssignedPiece[] = [];
  const initial = new DecompositionState(context);
  const evaluatedCandidates: CandidatePiece[] = [];
  for (const raw of ordered.slice(0, policy.maxCandidates)) {
    let candidate: CandidatePiece;
    try {
      candidate = { ...structuredClone(raw), cells: canonicalCells(raw.cells) };
      if (!initial.canClaim(candidate.cells)) throw new Error('Footprint leaves available ground or intersects reserved/forbidden cells.');
      context.analyze(candidate.cells);
      evaluatedCandidates.push(candidate);
    } catch (error) { diagnostics.push({ candidate: raw.id, status: 'rejected', reasons: [String(error)] }); continue; }
    for (const generator of [...generators].sort((a, b) => a.id.localeCompare(b.id))) {
      const fit = generatorFitness(context, candidate, generator);
      diagnostics.push({ candidate: candidate.id, generator: generator.id, status: fit.feasible ? 'not-selected' : 'rejected', reasons: fit.reasons, scores: fit.scores });
      if (fit.feasible) choices.push({ ...candidate, generator: generator.id, scores: fit.scores });
    }
  }
  const evaluate = (state: DecompositionState) => {
    const missing = (context.input.required || []).filter(c => !state.has(c)).length;
    return { ...scoreState(state, policy), missing };
  };
  type Branch = { state: DecompositionState; evaluation: ReturnType<typeof evaluate>; key: string };
  const first: Branch = { state: initial, evaluation: evaluate(initial), key: '' };
  const compare = (a: Branch, b: Branch) => a.evaluation.missing - b.evaluation.missing || b.evaluation.score - a.evaluation.score || a.key.localeCompare(b.key);
  let beam = [first], best = first, expanded = 0, budgetExhausted = false;
  for (let depth = 0; depth < policy.maxPieces && beam.length; depth++) {
    const next: Branch[] = [];
    const seen = new Set<string>();
    for (const branch of beam) for (let i = 0; i < choices.length; i++) {
      const choice = choices[i]!;
      if (!branch.state.canClaim(choice.cells)) continue;
      const key = [...branch.state.pieces.map(p => JSON.stringify([p.id, p.generator])), JSON.stringify([choice.id, choice.generator])].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      if (expanded >= 20000) { budgetExhausted = true; break; }
      const state = branch.state.withClaim(choice), trial: Branch = { state, evaluation: evaluate(state), key };
      expanded++; next.push(trial);
      if (compare(trial, best) < 0) best = trial;
      if (next.length > policy.beamWidth * 2) { next.sort(compare); next.length = policy.beamWidth; }
    }
    next.sort(compare); beam = next.slice(0, policy.beamWidth);
    if (budgetExhausted) break;
  }
  if (best.evaluation.missing) throw new Error('Bounded allocation found no plan covering every required cell; expand the candidate set or search budget.');
  const pieces = best.state.pieces;
  for (const d of diagnostics) if (d.status === 'not-selected') {
    if (pieces.some(p => p.id === d.candidate && p.generator === d.generator)) { d.status = 'selected'; d.reasons.push('Selected by the best retained allocation.'); }
    else d.reasons.push('Feasible alternative not selected by bounded search; overlap, score or beam pruning may exclude it.');
  }
  for (const c of ordered.slice(policy.maxCandidates)) diagnostics.push({ candidate: c.id, status: 'not-selected', reasons: ['Candidate budget exhausted before evaluation.'] });
  return { version: 'decomposition-1', context: structuredClone(context.input) as DecompositionPlan['context'], strategy: options.strategy || 'caller-policy', policy: { ...policy }, candidates: evaluatedCandidates, pieces,
    residuals: best.evaluation.residuals, interfaces: best.evaluation.interfaces, cuts: structuredClone(options.cuts || []), score: best.evaluation.score,
    scoreComponents: best.evaluation.components, diagnostics, search: { considered: Math.min(ordered.length, policy.maxCandidates), truncated: Math.max(0, ordered.length - policy.maxCandidates), expanded, beamWidth: policy.beamWidth, budgetExhausted, optimal: false } };
}
