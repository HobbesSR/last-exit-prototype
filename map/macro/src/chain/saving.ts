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
import { countParamsProblem, validateLibrary } from "./library.ts";
import { MACRO_VERSION, mapViews } from "./map.ts";
import type { ChainMap, ChainParams, Layout, MapEngines, Orientation, RegionResult } from "./types.ts";

/** The one wire version this reader takes and this writer gives. */
export const CHAIN_WIRE_VERSION = 8;

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
  library: ChainLibrary;
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

function unpackColumn(packed: PackedInts | undefined, field: string): Int32Array {
  if (!packed || packed.v === undefined) throw new Error(`${field} is missing packed integer data`);
  return unpackInts(packed);
}

function validateLayoutParams(params: unknown): void {
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new Error(`layout.params must be an object, not ${params === null ? "null" : typeof params}`);
  const p = params as Partial<ChainParams>;
  if (p.mode !== undefined && p.mode !== "game" && p.mode !== "playground")
    throw new Error(`layout.params.mode must be "game" or "playground", not ${String(p.mode)}`);
  if (!(Number.isSafeInteger(p.zoneWidth) && (p.zoneWidth as number) >= 1))
    throw new Error(`layout.params.zoneWidth must be a positive integer, not ${String(p.zoneWidth)}`);
  if (!(Number.isSafeInteger(p.zoneHeight) && (p.zoneHeight as number) >= 1))
    throw new Error(`layout.params.zoneHeight must be a positive integer, not ${String(p.zoneHeight)}`);
  const countError = countParamsProblem(p as ChainParams);
  if (countError) throw new Error(`layout.params.${countError}`);
  if (typeof p.lootChance !== "number" || !Number.isFinite(p.lootChance))
    throw new Error(`layout.params.lootChance must be a finite number, not ${String(p.lootChance)}`);
  if (typeof p.lootTierStep !== "number" || !Number.isFinite(p.lootTierStep))
    throw new Error(`layout.params.lootTierStep must be a finite number, not ${String(p.lootTierStep)}`);
}

function unpackLayout(wire: WireLayout, name: (id: number) => string): Layout {
  if (!wire.slots || typeof wire.slots !== "object")
    throw new Error(`layout.slots must be an object, not ${wire.slots === null ? "null" : typeof wire.slots}`);
  if (!wire.setPieces || typeof wire.setPieces !== "object")
    throw new Error(`layout.setPieces must be an object, not ${wire.setPieces === null ? "null" : typeof wire.setPieces}`);

  const col = unpackColumn(wire.slots.col, "layout.slots.col");
  const row = unpackColumn(wire.slots.row, "layout.slots.row");
  const design = unpackColumn(wire.slots.design, "layout.slots.design");
  const orientation = unpackColumn(wire.slots.orientation, "layout.slots.orientation");
  if (row.length !== col.length || design.length !== col.length || orientation.length !== col.length)
    throw new Error(`layout.slots columns have mismatched lengths (col=${col.length}, row=${row.length}, design=${design.length}, orientation=${orientation.length})`);
  const slots = Array.from(col, (c, i) => {
    const o = orientation[i]!;
    if (o < 0 || o > 3) throw new Error(`layout.slots.orientation[${i}] must be 0..3, not ${o}`);
    return { col: c, row: row[i]!, design: name(design[i]!), orientation: (o * 90) as Orientation };
  });

  const ids = unpackColumn(wire.setPieces.id, "layout.setPieces.id");
  const pieces = unpackColumn(wire.setPieces.setPiece, "layout.setPieces.setPiece");
  const classes = unpackColumn(wire.setPieces.setPieceClass, "layout.setPieces.setPieceClass");
  const counts = unpackColumn(wire.setPieces.slotCount, "layout.setPieces.slotCount");
  if (pieces.length !== ids.length || classes.length !== ids.length || counts.length !== ids.length)
    throw new Error(`layout.setPieces columns have mismatched lengths (id=${ids.length}, setPiece=${pieces.length}, setPieceClass=${classes.length}, slotCount=${counts.length})`);
  const slotCol = unpackColumn(wire.setPieces.slotCol, "layout.setPieces.slotCol");
  const slotRow = unpackColumn(wire.setPieces.slotRow, "layout.setPieces.slotRow");
  if (slotCol.length !== slotRow.length)
    throw new Error(`layout.setPieces slot columns have mismatched lengths (slotCol=${slotCol.length}, slotRow=${slotRow.length})`);
  let totalSlots = 0;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i]!;
    if (count < 0) throw new Error(`layout.setPieces.slotCount[${i}] must be non-negative, not ${count}`);
    totalSlots += count;
  }
  if (totalSlots !== slotCol.length)
    throw new Error(`layout.setPieces.slotCount sums to ${totalSlots}, but slotCol/slotRow have ${slotCol.length} entries`);

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
  const library = savedLibrary(map.library);
  if (libraryFingerprint(library) !== map.layout.library) throw new Error("the map's library does not match its layout fingerprint");
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
  return { format: "last-exit-map", wire: CHAIN_WIRE_VERSION, library: structuredClone(library), strings: strings.table, layout, build };
}

/** Structural validation is independent of the installed game's strategy registry. */
function savedLibrary(input: unknown): ChainLibrary {
  const classes = (input as Partial<ChainLibrary> | null)?.cellClasses;
  const types = new Set(Object.values(classes ?? {}).map(value => value?.regionType));
  const checked = validateLibrary(input, types);
  if (!checked.valid) throw new Error(`invalid saved library: ${checked.errors.join('; ')}`);
  return input as ChainLibrary;
}

/**
 * A map from its wire form, with the library it was made from. A save of the Layout alone
 * rebuilds its results with `engines`, which must be the version that the save records.
 */
export function decodeChainMap<Element = unknown>(input: unknown, expectedLibrary?: ChainLibrary, engines?: MapEngines<Element>): ChainMap<Element> {
  const wire = input as WireChainMap;
  if (!wire || typeof wire !== "object" || wire.format !== "last-exit-map" || typeof wire.wire !== "number")
    throw new Error("not a last-exit-map artifact");
  if (wire.wire !== CHAIN_WIRE_VERSION)
    throw new Error(`unsupported wire version ${wire.wire}; this reader takes wire version ${CHAIN_WIRE_VERSION}; regenerate the map from its seed`);
  if (!Array.isArray(wire.strings) || !wire.layout || typeof wire.layout !== "object" || !wire.build || typeof wire.build !== "object")
    throw new Error("a chain map needs its strings, layout and build");
  if (wire.layout.macro !== MACRO_VERSION)
    throw new Error(`this layout was placed by macro version ${wire.layout.macro}, and this reader's stages are version ${MACRO_VERSION}; regenerate it from its seed`);
  if (typeof wire.layout.seed !== "string")
    throw new Error(`layout.seed must be a string, not ${String(wire.layout.seed)}`);
  validateLayoutParams(wire.layout.params);
  if (typeof wire.layout.library !== "string")
    throw new Error(`layout.library must be a string, not ${String(wire.layout.library)}`);
  if (typeof wire.build.version !== "string")
    throw new Error(`build.version must be a string, not ${String(wire.build.version)}`);
  if (typeof wire.build.cellSize !== "number" || !Number.isFinite(wire.build.cellSize) || wire.build.cellSize <= 0)
    throw new Error(`build.cellSize must be a positive number, not ${String(wire.build.cellSize)}`);
  if (wire.build.format !== "region-2") throw new Error(`its results are ${String(wire.build.format)}, and this reader takes region-2`);
  if (wire.build.results !== undefined && !Array.isArray(wire.build.results))
    throw new Error(`build.results must be an array, not ${typeof wire.build.results}`);
  const library = savedLibrary(wire.library);
  const expected = libraryFingerprint(library);
  if (wire.layout.library !== expected)
    throw new Error(`this map was made with a different library (${wire.layout.library}, not ${expected}); read it with the library it was made from`);
  if (expectedLibrary && libraryFingerprint(expectedLibrary) !== expected)
    throw new Error("this map was made with a different library than the supplied library");
  const name = (id: number): string => {
    const value = wire.strings[id];
    if (typeof value !== "string") throw new Error(`string ${id} is not in the table`);
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
export function readChainMap<Element = unknown>(bytes: Uint8Array, library?: ChainLibrary, engines?: MapEngines<Element>): ChainMap<Element> {
  const input = looksLikeBson(bytes) ? decodeBson(bytes) : JSON.parse(new TextDecoder().decode(bytes));
  return decodeChainMap(input, library, engines);
}
