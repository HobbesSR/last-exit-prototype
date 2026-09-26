/**
 * The catalogue of region generators.
 *
 * Which generator runs over a region is library data, not code: a class rule
 * names one by id in `cellClasses[class].generator`, and anything unnamed or
 * unknown falls back. Registration is by value, so a builder is an ordinary
 * module export rather than a subclass of anything.
 */
import type { CellClass } from "../types.ts";
import type { RegionBuilder } from "./types.ts";

const builders = new Map<string, RegionBuilder>();
let fallbackId = "";

/** Register a builder, or replace one registered under the same id. */
export function registerBuilder(builder: RegionBuilder): void {
  if (!builder.id) throw new TypeError("a region builder needs an id");
  if (typeof builder.build !== "function")
    throw new TypeError(`region builder ${builder.id} has no build function`);
  builders.set(builder.id, builder);
}

/**
 * Name the builder used when a class names none, names one that is not
 * registered, or names one that cannot work at the region's size.
 */
export function setFallbackBuilder(id: string): void {
  if (!builders.has(id)) throw new TypeError(`no such region builder: ${id}`);
  fallbackId = id;
}

export function getBuilder(id: string): RegionBuilder | undefined {
  return builders.get(id);
}

/** Every registered builder, in id order, for tooling that lists the catalogue. */
export function listBuilders(): RegionBuilder[] {
  return [...builders.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The builder that owns a region of this class and size. Falls back rather than
 * failing: a region too small for the generator its class asked for still gets
 * the scatter treatment, which every area can take.
 */
export function builderFor(rule: CellClass, area: number): RegionBuilder {
  const fallback = builders.get(fallbackId);
  const named = rule.generator ? builders.get(rule.generator) : undefined;
  if (named && area >= named.minArea) return named;
  if (!fallback) throw new Error("no fallback region builder is registered");
  return fallback;
}

/** Drop every registration. Tests use this to isolate a catalogue. */
export function resetCatalogue(): void {
  builders.clear();
  fallbackId = "";
}
