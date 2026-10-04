import type { Cell } from '../../kernel/cell.ts';

/** The one owner outside the building footprint, including enclosed holes. */
export const OUTSIDE = 'outside';
export type BuildingSide = 'N' | 'E' | 'S' | 'W';
export type OpeningKind = 'door' | 'open' | 'window';

export interface BuildingSpace {
  id: string;
  area: { min: number; max: number };
  outside?: 'prefer' | 'avoid' | 'any';
  tags?: string[];
}
export interface BuildingConnection {
  id: string;
  a: string;
  b: string;
  kind: OpeningKind;
  /** Optional exterior orientation preference. */
  side?: BuildingSide;
}
export interface BuildingDesign { spaces: BuildingSpace[]; connections: BuildingConnection[] }
export interface BuildingAllocation {
  footprint: Cell[];
  spaces: { id: string; cells: Cell[] }[];
}

/** Design labels are guidance; validation checks only structural integrity. */
export function validateBuildingDesign(design: BuildingDesign): string[] {
  const issues: string[] = [], ids = new Set<string>(), connections = new Set<string>();
  for (const space of design.spaces) {
    if (!space.id || space.id === OUTSIDE || ids.has(space.id)) issues.push(`Duplicate or reserved space id: ${space.id}`);
    ids.add(space.id);
    if (!Number.isSafeInteger(space.area.min) || !Number.isSafeInteger(space.area.max)
      || space.area.min < 1 || space.area.max < space.area.min) issues.push(`Invalid area for space ${space.id}`);
    if (space.outside !== undefined && !['prefer', 'avoid', 'any'].includes(space.outside)) issues.push(`Invalid outside preference for ${space.id}`);
    if (space.tags?.some(tag => !tag)) issues.push(`Empty tag for ${space.id}`);
  }
  if (!design.spaces.length) issues.push('A building needs a space.');
  for (const connection of design.connections) {
    if (!connection.id || connections.has(connection.id)) issues.push(`Duplicate connection id: ${connection.id}`);
    connections.add(connection.id);
    if (!ids.has(connection.a) && connection.a !== OUTSIDE) issues.push(`Unknown space: ${connection.a}`);
    if (!ids.has(connection.b) && connection.b !== OUTSIDE) issues.push(`Unknown space: ${connection.b}`);
    if (connection.a === connection.b) issues.push(`Self connection: ${connection.id}`);
    if (!['door', 'open', 'window'].includes(connection.kind)) issues.push(`Invalid connection kind: ${connection.id}`);
    if (connection.side !== undefined && !['N', 'E', 'S', 'W'].includes(connection.side)) issues.push(`Invalid side: ${connection.id}`);
    // Interior boundaries have no exterior side, so the preference could never be met.
    if (connection.side !== undefined && connection.a !== OUTSIDE && connection.b !== OUTSIDE) issues.push(`A side needs an outside end: ${connection.id}`);
  }
  return issues;
}
