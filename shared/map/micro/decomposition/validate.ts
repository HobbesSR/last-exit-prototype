import { createRegionContext } from './context.ts';
import { DecompositionState, generatorFitness, scoreState, validateAllocationPolicy } from './allocation.ts';
import { buildInterfaces } from './interfaces.ts';
import { canonicalCells, cellKey, connectedComponents } from './analysis.ts';
import type { DecompositionPlan, GeneratorContract } from './types.ts';

/** Independently check ownership and claims. Does not assert optimality or physical access. */
export function validateDecompositionPlan(plan: DecompositionPlan, generators?: GeneratorContract[]): string[] {
  const errors: string[] = [];
  try {
    if (plan.version !== 'decomposition-1') throw new Error('Unsupported decomposition artifact.');
    validateAllocationPolicy(plan.policy);
    if (plan.pieces.length > plan.policy.maxPieces || plan.candidates.length > plan.policy.maxCandidates || plan.cuts.length > 64) throw new Error('Decomposition artifact exceeds its bounds.');
    const context = createRegionContext(plan.context), owned = new Set(context.input.cells.map(cellKey));
    let state = new DecompositionState(context);
    for (const piece of plan.pieces) {
      state = state.withClaim(piece);
      if (!piece.generator || !piece.role || Object.values(piece.scores).some(value => !Number.isFinite(value))) errors.push('Invalid generator assignment.');
      if (generators) {
        const g = generators.find(g => g.id === piece.generator);
        if (!g) errors.push(`Unknown generator ${piece.generator}.`);
        else {
          const fit = generatorFitness(context, piece, g);
          if (!fit.feasible) errors.push(`Piece ${piece.id} fails its generator contract.`);
          if (JSON.stringify(fit.scores) !== JSON.stringify(piece.scores)) errors.push(`Piece ${piece.id} has altered generator utility.`);
        }
      }
    }
    if ((context.input.required || []).some(c => !state.has(c))) errors.push('Required cells remain unassigned.');
    if (JSON.stringify(state.residuals()) !== JSON.stringify(plan.residuals)) errors.push('Residual ownership is incomplete, overlapping or altered.');
    if (JSON.stringify(buildInterfaces([...state.pieces, ...state.residuals()], plan.policy.portalWidth)) !== JSON.stringify(plan.interfaces)) errors.push('Interfaces disagree with assigned boundaries.');
    if (!Number.isFinite(plan.score) || Object.values(plan.scoreComponents).some(n => !Number.isFinite(n)) || Math.abs(Object.values(plan.scoreComponents).reduce((s, n) => s + n, 0) - plan.score) > 1e-7) errors.push('Invalid score accounting.');
    const score = scoreState(state, plan.policy);
    if (Math.abs(score.score - plan.score) > 1e-7 || JSON.stringify(score.components) !== JSON.stringify(plan.scoreComponents)) errors.push('Score components disagree with allocation measurements.');
    const candidateIds = new Set<string>();
    for (const candidate of plan.candidates) {
      if (candidateIds.has(candidate.id)) errors.push('Duplicate candidate identity.');
      candidateIds.add(candidate.id);
      if (!new DecompositionState(context).canClaim(canonicalCells(candidate.cells))) errors.push('Candidate leaves available region.');
    }
    for (const piece of plan.pieces) {
      const candidate = plan.candidates.find(c => c.id === piece.id);
      if (!candidate || candidate.role !== piece.role || JSON.stringify(candidate.cells) !== JSON.stringify(piece.cells)) errors.push('Assignment disagrees with its candidate footprint.');
    }
    for (const cut of plan.cuts) {
      const cells = canonicalCells(cut.cells), removed = new Set(cells.map(cellKey));
      if (cells.some(c => !owned.has(cellKey(c)))) errors.push('Cut leaves region.');
      const excluded = new Set([...(context.input.reserved || []), ...(context.input.forbidden || [])].map(cellKey));
      const components = connectedComponents(context.input.cells.filter(c => !removed.has(cellKey(c)) && !excluded.has(cellKey(c))));
      if (JSON.stringify(components) !== JSON.stringify(cut.components) || JSON.stringify(components.map(c => c.length)) !== JSON.stringify(cut.resultingAreas)) errors.push('Cut topology disagrees with its proposal.');
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return errors;
}
