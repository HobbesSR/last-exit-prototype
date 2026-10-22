import { rect } from '../../../shared/shape.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { ElementTemplate } from '../../../shared/map/element.ts';
import type { Box } from '../../../shared/types.ts';
import type { RegionElement } from '../types.ts';

/**
 * A placeable (20.8, #405): one kind of thing a builder can put down, such as a warehouse, a
 * house or a piece of cover. It owns what the thing is and the area it demands control of, never
 * where that area goes: siting stays the builder's. Placeables are code, not data, because each
 * may have its own mechanics. They are registered in `index.ts`, an explicit list.
 *
 * `build` is pure. It draws no random numbers except from a seed its parameters carry, and it
 * assigns no ids: those come when the region is stamped, in element and part order. So a
 * placeable's part order is frozen for its version, as a template's is (`element.ts`).
 */
export interface Placeable<P, D = undefined> {
  /** Unique in the registry. */
  id: string;
  /** Bump it when `build` changes what it returns, and bump `REGION_TYPES_VERSION` with it. */
  version: string;
  /** One line for lists, such as the Lab's. */
  summary: string;
  /** Every parameter `build` reads, in a fixed order. */
  params: readonly ParamSpec[];
  /** Rules across parameters that the specs can't state. */
  check?(params: P): string[];
  /** Parameters for previews and the version test. */
  examples: readonly P[];
  build(params: P, cellSize: number): Placed<D> | Refusal;
}

/** A parameter described for validation and tools. Numbers are bounded inclusive. */
export type ParamSpec = { name: string; summary: string } & (
  | { kind: 'int' | 'number'; min: number; max: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] });

/** The area a placeable needs control of, in cells local to its body's corner. */
export interface Demand {
  /** The cells its elements stand in, from (0, 0). Every part lies in this box. */
  body: { w: number; h: number };
  /** Cells outside the body that it relies on staying clear, such as a doorstep. Disjoint from the body and each other. */
  clear: readonly Box[];
}

/** One element of a placed thing, in world units local to its body's corner. */
export interface PlacedElement {
  /** Appended to the builder's label, when a thing is several elements. */
  name?: string;
  x: number;
  y: number;
  template: ElementTemplate;
}

export interface Placed<D> {
  elements: PlacedElement[];
  demand: Demand;
  /** What a builder or tool may want beyond the geometry, such as a building's design. Never part of the map. */
  details: D;
}

/** A placeable that can't be built from these parameters, and why. A defect throws instead. */
export interface Refusal { refused: string }

/** `result`, from a call its builder knows can't be refused. A refusal there is a defect, so it throws. */
export function expectPlaced<D>(result: Placed<D> | Refusal): Placed<D> {
  if ('refused' in result) throw new Error(`An unrefusable placement was refused: ${result.refused}`);
  return result;
}

/** The region's elements for a thing placed with its body's corner at cell `x`, `y`. */
export function placedElements(placed: Placed<unknown>, label: string, x: number, y: number, cellSize: number): RegionElement[] {
  return placed.elements.map(e => ({ label: e.name ? `${label}-${e.name}` : label, x: x * cellSize + e.x, y: y * cellSize + e.y, template: e.template }));
}

/** The demand as world-unit shapes for a body at cell `x`, `y`: the body first, then each clear box. They never overlap, so an addressed area (20.2) can mark each. */
export function demandShapes(demand: Demand, x: number, y: number, cellSize: number): Shape[] {
  const box = (b: Box) => rect((x + b.x) * cellSize, (y + b.y) * cellSize, b.w * cellSize, b.h * cellSize);
  return [box({ x: 0, y: 0, ...demand.body }), ...demand.clear.map(box)];
}

/** What is wrong with `params` for `placeable`: unknown or missing names, values out of their spec, then its own check. */
export function placeableErrors(placeable: Placeable<any, unknown>, params: unknown): string[] {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [`${placeable.id} needs a parameter object.`];
  const record = params as Record<string, unknown>, errors: string[] = [];
  const names = new Set(placeable.params.map(spec => spec.name));
  for (const key of Object.keys(record)) if (!names.has(key)) errors.push(`${placeable.id} has no parameter ${key}.`);
  for (const spec of placeable.params) {
    const value = record[spec.name], name = `${placeable.id} ${spec.name}`;
    if (value === undefined) errors.push(`${name} is missing.`);
    else if (spec.kind === 'boolean') { if (typeof value !== 'boolean') errors.push(`${name} must be true or false.`); }
    else if (spec.kind === 'enum') { if (!spec.values.includes(value as string)) errors.push(`${name} must be one of ${spec.values.join(', ')}.`); }
    else if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max || (spec.kind === 'int' && !Number.isInteger(value)))
      errors.push(`${name} must be ${spec.kind === 'int' ? 'a whole number' : 'a number'} from ${spec.min} to ${spec.max}.`);
  }
  return errors.length ? errors : placeable.check?.(params) ?? [];
}
