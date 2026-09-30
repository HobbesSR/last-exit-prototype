import { composeMicroRegions } from './compose.ts';
import { validateBoundaryComposition } from './boundary.ts';
import { elementShapes } from './geometry.ts';
import { negotiatePortals } from './decomposition/negotiate.ts';
import type { MicroLayout } from './compose.ts';
import type { NegotiatedPortals, PortalPolicy } from './decomposition/negotiate.ts';
import type { AssignedPiece, DecompositionPlan, ResidualRegion } from './decomposition/types.ts';
import type { RegionPort, RegionSpec } from './types.ts';

/** What a generator id or residual becomes. Ports and ownership are not the dispatcher's to choose. */
export type DispatchedContent = Pick<RegionSpec, 'builder'> & Partial<Pick<RegionSpec, 'parameters' | 'loot' | 'entry'>>;
/** Content for one allocated piece or residual; null leaves a residual unrealized, outside the parent. */
export type Dispatcher = (part: AssignedPiece | ResidualRegion) => DispatchedContent | null;

export interface ExecutionOptions {
  seed: number;
  bodyProfile?: 'live' | 'cell';
  /** The parent's own obligations, in global cells. Each must lie wholly inside one child. */
  ports?: RegionPort[];
  dispatch: Dispatcher;
  portals: PortalPolicy;
}
export interface ExecutedDecomposition {
  parts: Array<{ id: string; role: string; generator: string | null }>;
  negotiation: NegotiatedPortals;
  layout: MicroLayout;
}

/**
 * Dispatch a flat plan's parts to builders, negotiate their shared boundaries,
 * generate them and prove the result against the parent's contract. The plan's
 * ownership is used as given: nothing here re-partitions or repairs geometry.
 */
export function executeDecomposition(plan: DecompositionPlan, options: ExecutionOptions): ExecutedDecomposition {
  if (!Number.isSafeInteger(options.seed) || typeof options.dispatch !== 'function') throw new Error('Execution needs an integer seed and a dispatcher.');
  const realized: Array<{ part: AssignedPiece | ResidualRegion; content: DispatchedContent }> = [];
  for (const part of [...plan.pieces, ...plan.residuals]) {
    const content = options.dispatch(part);
    if (!content) {
      if ('generator' in part) throw new Error(`Allocated piece ${part.id} has no dispatched content.`);
      continue;
    }
    realized.push({ part, content });
  }
  if (!realized.length || realized.length > 16) throw new Error('Execution requires 1 to 16 realized regions.');
  const bodyProfile = options.bodyProfile ?? 'live', cellSize = plan.context.cellSize;
  const parent = { cells: realized.flatMap(r => r.part.cells), cellSize, bodyProfile, ports: structuredClone(options.ports ?? []) };
  const negotiation = negotiatePortals(parent, realized.map(r => r.part), plan.interfaces, options.portals);
  const specs: RegionSpec[] = realized.map(({ part, content }) => ({ id: part.id, cells: structuredClone(part.cells), cellSize, seed: options.seed,
    builder: content.builder, bodyProfile, ports: negotiation.ports[part.id]!,
    ...(content.parameters ? { parameters: structuredClone(content.parameters) } : {}),
    ...(content.loot ? { loot: { ...content.loot } } : {}), ...(content.entry ? { entry: { ...content.entry } } : {}) }));
  const layout = composeMicroRegions(specs);
  const boundary = validateBoundaryComposition(parent, layout.regions.map(region => ({ ...region.spec, blockers: region.elements.flatMap(e => elementShapes(e)) })));
  if (!boundary.valid) throw new Error(`Child boundary contract failed: ${boundary.errors.join(' ')}`);
  return { parts: realized.map(({ part }) => ({ id: part.id, role: part.role, generator: 'generator' in part ? part.generator : null })), negotiation, layout };
}
