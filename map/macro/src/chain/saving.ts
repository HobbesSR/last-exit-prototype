/**
 * Saving a chain map (51 "Saving", 53). A save holds the Layout and, optionally, the region
 * results, never a view. Each records its inputs and the version of the algorithm that
 * made it:
 * - the Layout: its seed, params and library fingerprint, and `MACRO_VERSION`
 * - the results: the cell size and the game's `MapEngines` version
 *
 * A missing result is rebuilt from the Layout, and a version mismatch is refused by name,
 * never done silently.
 *
 * The Layout goes through the wire form: names interned, columns packed. Region results
 * are the game's own `region-2` data, which macro can't read, stored as given less their
 * briefs. A brief is a view of the Layout, so it is derived again on read.
 */
import { decodeBson, encodeBson, looksLikeBson } from "../bson.ts";
import type { BsonValue } from "../bson.ts";
import { Strings, canonicalJson, libraryFingerprint, packInts, unpackInts, widen } from "../coding.ts";
import type { PackedInts } from "../coding.ts";
import type { ChainLibrary } from "./library.ts";
import { MACRO_VERSION, mapViews } from "./map.ts";
import type { ChainMap, Layout, MapEngines, Orientation, RegionResult } from "./types.ts";

/** Versions 5 and up are the chain's. The old generators' reader and version 4 were deleted at the switch-over. */
export const CHAIN_WIRE_VERSION = 6;
/** Why each earlier wire version isn't read here. None is migrated. */
const RETIRED_VERSIONS: Record<number, string> = {
  1: "it is mapgen's old form, which the chain replaced",
  2: "it is mapgen's old form, which the chain replaced",
  3: "it is mapgen's old form, which the chain replaced",
  4: "it holds a map from mapgen's old generators, which retired at the switch-over (#146); regenerate it on the chain",
  5: "its params have no contestantCount or hunterCount, which spawn counts name since #124; regenerate it from its seed",
};

/** Placement's draws. Positions and orientations are columns; names go through the string table. */
interface WireLayout {
  macro: number;
  seed: string;
  params: Layout["params"];
  library: string;
  slots: { col: PackedInts; row: PackedInts; design: PackedInts; orientation: PackedInts };
  /** Each instance's slots are `slotCount` consecutive entries of `slotCol` and `slotRow`. */
  setPieces: { id: PackedInts; setPiece: PackedInts; setPieceClass: PackedInts; slotCount: PackedInts; slotCol: PackedInts; slotRow: PackedInts };
}
/** A region result less its brief, which is a view. One per brief, in the briefs' order. */
type WireResult = Omit<RegionResult, "version" | "brief">;
/** What a saved result holds, and nothing else: its version is the build's, and its brief is derived. */
const RESULT_FIELDS = ["elements", "coreElements", "loot", "manifest"] as const satisfies readonly (keyof WireResult)[];
interface WireBuild {
  /** The `MapEngines` version that built the results, or that must rebuild them. */
  version: string;
  cellSize: number;
  format: RegionResult["version"];
  /** Absent in a save of the Layout alone. */
  results?: WireResult[];
}
export interface WireChainMap {
  format: "last-exit-map";
  wire: number;
  strings: string[];
  layout: WireLayout;
  build: WireBuild;
}

export interface SaveOptions {
  /** False saves the Layout alone, and reading it back rebuilds the results. */
  results?: boolean;
}

function packLayout(layout: Layout, strings: Strings): WireLayout {
  const instanceSlots = layout.setPieces.flatMap((instance) => instance.slots);
  return {
    macro: MACRO_VERSION,
    seed: layout.seed,
    params: { ...layout.params },
    library: layout.library,
    slots: {
      col: packInts(layout.slots.map((slot) => slot.col)),
      row: packInts(layout.slots.map((slot) => slot.row)),
      design: packInts(layout.slots.map((slot) => strings.id(slot.design))),
      orientation: packInts(layout.slots.map((slot) => slot.orientation / 90)),
    },
    setPieces: {
      id: packInts(layout.setPieces.map((instance) => strings.id(instance.id))),
      setPiece: packInts(layout.setPieces.map((instance) => strings.id(instance.setPiece))),
      setPieceClass: packInts(layout.setPieces.map((instance) => strings.id(instance.setPieceClass))),
      slotCount: packInts(layout.setPieces.map((instance) => instance.slots.length)),
      slotCol: packInts(instanceSlots.map((slot) => slot.col)),
      slotRow: packInts(instanceSlots.map((slot) => slot.row)),
    },
  };
}

function unpackLayout(wire: WireLayout, name: (id: number) => string): Layout {
  const col = unpackInts(wire.slots.col), row = unpackInts(wire.slots.row);
  const design = unpackInts(wire.slots.design), orientation = unpackInts(wire.slots.orientation);
  const slots = Array.from(col, (c, i) => ({ col: c, row: row[i]!, design: name(design[i]!), orientation: (orientation[i]! * 90) as Orientation }));
  const ids = unpackInts(wire.setPieces.id), pieces = unpackInts(wire.setPieces.setPiece), classes = unpackInts(wire.setPieces.setPieceClass);
  const counts = unpackInts(wire.setPieces.slotCount), slotCol = unpackInts(wire.setPieces.slotCol), slotRow = unpackInts(wire.setPieces.slotRow);
  let at = 0;
  const setPieces = Array.from(ids, (id, i) => {
    const taken = Array.from({ length: counts[i]! }, (_, j) => ({ col: slotCol[at + j]!, row: slotRow[at + j]! }));
    at += counts[i]!;
    return { id: name(id), setPiece: name(pieces[i]!), setPieceClass: name(classes[i]!), slots: taken };
  });
  return { seed: wire.seed, params: { ...wire.params }, library: wire.library, slots, setPieces };
}

/**
 * A map's wire form. Each result must hold the brief its Layout gives, since a brief is
 * derived again on read and a different one would silently change.
 */
export function encodeChainMap(map: ChainMap, options: SaveOptions = {}): WireChainMap {
  const strings = new Strings();
  const layout = packLayout(map.layout, strings);
  const build: WireBuild = { version: map.build, cellSize: map.cellSize, format: "region-2" };
  if (options.results !== false) {
    const briefs = mapViews(map).briefs;
    if (map.results.length !== briefs.length) throw new Error(`the map holds ${map.results.length} results, but its layout gives ${briefs.length} briefs`);
    build.results = map.results.map(({ version, brief, elements, coreElements, loot, manifest }, i) => {
      if (version !== "region-2") throw new Error(`region ${brief.id}'s result is ${version}, not region-2`);
      // Compared by content, not key order: a strategy may build an equal brief in its own order.
      if (canonicalJson(brief) !== canonicalJson(briefs[i]))
        throw new Error(`region ${brief.id}'s result doesn't hold the brief its layout gives (${briefs[i]!.id})`);
      return { elements, coreElements, loot, manifest };
    });
  }
  return { format: "last-exit-map", wire: CHAIN_WIRE_VERSION, strings: strings.table, layout, build };
}

/**
 * A map from its wire form, with the library it was made from. A save of the Layout alone
 * rebuilds its results with `engines`, which must be the version that the save records.
 */
export function decodeChainMap<Element = unknown>(input: unknown, library: ChainLibrary, engines?: MapEngines<Element>): ChainMap<Element> {
  const wire = input as WireChainMap;
  if (!wire || wire.format !== "last-exit-map" || typeof wire.wire !== "number") throw new Error("not a last-exit-map artifact");
  const retired = RETIRED_VERSIONS[wire.wire];
  if (retired) throw new Error(`wire version ${wire.wire} isn't a chain map: ${retired}. This reader takes wire version ${CHAIN_WIRE_VERSION}`);
  if (wire.wire !== CHAIN_WIRE_VERSION) throw new Error(`unsupported wire version ${wire.wire}; this reader takes wire version ${CHAIN_WIRE_VERSION}`);
  if (!Array.isArray(wire.strings) || !wire.layout || !wire.build) throw new Error("a chain map needs its strings, layout and build");
  if (wire.layout.macro !== MACRO_VERSION)
    throw new Error(`this layout was placed by macro version ${wire.layout.macro}, and this reader's stages are version ${MACRO_VERSION}; regenerate it from its seed`);
  const expected = libraryFingerprint(library);
  if (wire.layout.library !== expected)
    throw new Error(`this map was made with a different library (${wire.layout.library}, not ${expected}); read it with the library it was made from`);
  if (wire.build.format !== "region-2") throw new Error(`its results are ${String(wire.build.format)}, and this reader takes region-2`);
  const name = (id: number): string => {
    const value = wire.strings[id];
    if (value === undefined) throw new Error(`string ${id} is not in the table`);
    return value;
  };

  const layout = unpackLayout(wire.layout, name);
  const { version: build, cellSize } = wire.build;
  const map: ChainMap<Element> = { layout, library, cellSize, build, results: [] };
  const briefs = mapViews(map).briefs;
  if (wire.build.results) {
    if (wire.build.results.length !== briefs.length)
      throw new Error(`the save holds ${wire.build.results.length} results, but its layout gives ${briefs.length} briefs`);
    map.results = wire.build.results.map((saved, i) => {
      // A saved result holds no version or brief of its own, so nothing can override the derived ones.
      const stray = Object.keys(saved).filter((key) => !(RESULT_FIELDS as readonly string[]).includes(key));
      if (stray.length) throw new Error(`region ${briefs[i]!.id}'s saved result holds ${stray.join(", ")}, which a save never holds`);
      const { elements, coreElements, loot, manifest } = saved;
      return { version: "region-2", brief: briefs[i]!, elements, coreElements, loot, manifest } as RegionResult<Element>;
    });
  } else {
    if (!engines) throw new Error("this save holds the Layout alone; rebuilding its results needs the game's engines");
    if (engines.version !== build)
      throw new Error(`its results were built by strategies ${build}, not ${engines.version}; rebuild with ${build}, or regenerate the map`);
    map.results = briefs.map((brief) => engines.build(brief));
  }
  return map;
}

export function chainMapToJson(map: ChainMap, options?: SaveOptions, space?: number): string {
  return JSON.stringify(widen(encodeChainMap(map, options)), null, space);
}
export function chainMapToBson(map: ChainMap, options?: SaveOptions): Uint8Array {
  return encodeBson(encodeChainMap(map, options) as unknown as Record<string, BsonValue>);
}
/** Read either encoding, decided by the bytes rather than by a file name. */
export function readChainMap<Element = unknown>(bytes: Uint8Array, library: ChainLibrary, engines?: MapEngines<Element>): ChainMap<Element> {
  const input = looksLikeBson(bytes) ? decodeBson(bytes) : JSON.parse(new TextDecoder().decode(bytes));
  return decodeChainMap(input, library, engines);
}
