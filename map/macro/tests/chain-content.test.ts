/**
 * B4 (#97): the chain's own libraries, `content/diamond-12x6.json` and, since S6 (#171),
 * `diamond-24x12.json` and `diamond-36x18.json`, authored against the catalogue (54), with
 * set pieces on the old library's footprints since S5 (#170). Their region types are checked
 * against the game's registry in the root `tests/map-library.test.js`, since macro doesn't
 * import micro (50).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { orientDesign, parseKey } from "../src/chain/declared-grid.ts";
import { CHAIN_TILE_SIZE, validateLibrary } from "../src/chain/library.ts";
import type { Orientation } from "../src/chain/types.ts";
import { checkGameLayouts, SIZES } from "./chain-content-fixture.ts";

/** The catalogue (54): its minimal set, the types B3 built, and the types S4 drafted. */
const CATALOGUE = new Set([
  "open", "cover", "rubble", "hut", "arrival", "departure", "charging", "transit",
  "ruins", "hall", "depot", "compound", "block", "market", "plant", "checkpoint", "park",
]);
/** The width of the narrowest passage the content may form: a doorway plus one, as `cover`'s aisle (54). */
const BLOCK = 3;

for (const { name, library: LIBRARY, quotas: QUOTAS } of SIZES) test(`${name} is valid, and paints every type in the catalogue`, () => {
  assert.deepEqual(validateLibrary(LIBRARY, CATALOGUE), { valid: true, errors: [] });
  assert.deepEqual(new Set(Object.values(LIBRARY.cellClasses).map((c) => c.regionType)), CATALOGUE);
  for (const [id, rule] of Object.entries(LIBRARY.cellClasses)) assert.equal(rule.regionType, id);
  assert.deepEqual(Object.fromEntries(LIBRARY.setPieceClasses.map(c => [c.id, c.quota])), QUOTAS);
  for (const c of LIBRARY.setPieceClasses) assert.equal(c.placementRule, c.id);
});

test("each library authors a larger size's enormous pieces larger than its medium and small ones", () => {
  // A piece that is enormous at one size may be medium at another (55).
  for (const { name, library } of SIZES) {
    const area = new Map(library.setPieces.map((piece) => [piece.id, piece.tiles.length]));
    const sizes = (id: string) => library.setPieceClasses.find((c) => c.id === id)!.setPieces.map((piece) => area.get(piece)!);
    assert.ok(Math.min(...sizes("enormous")) > Math.max(...sizes("medium")), `${name}: enormous over medium`);
    assert.ok(Math.min(...sizes("medium")) >= Math.max(...sizes("small")) * 0.75, `${name}: medium about small`);
  }
});

test("every design keeps its declared classes and passable stretches on a three-cell grid", () => {
  // Authored concrete boundaries and openings use three-cell blocks (17 M9). This checks
  // authorship, not a proof of the final geometry: adjacency asks can settle `any` cells
  // individually. Placement and the authored clear-tile access tests check those results.
  for (const { library: LIBRARY } of SIZES) for (const design of LIBRARY.tiles) for (const orientation of design.orientations) {
    const { cells, segments } = orientDesign(design, orientation as Orientation), at = `${design.id}@${orientation}`;
    // Deferring cells are authored in whole blocks too. Neighbor asks may settle them per cell;
    // placement still rejects conflicting asks and short derived portals (51.3, 51.4).
    assert.ok(cells.every(cell => cell === "any" || CATALOGUE.has(cell)), `${at} paints declared classes`);
    for (let y = 0; y < CHAIN_TILE_SIZE; y++) for (let x = 0; x < CHAIN_TILE_SIZE; x++)
      assert.equal(cells[y * CHAIN_TILE_SIZE + x], cells[(y - y % BLOCK) * CHAIN_TILE_SIZE + x - x % BLOCK], `${at} cell ${x},${y}`);
    const passable = new Set([...segments].filter(([, s]) => s.passability === "passable").map(([key]) => key));
    for (const key of passable) {
      const { axis, x, y } = parseKey(key), offset = axis === "v" ? y : x, first = offset - offset % BLOCK;
      for (let i = first; i < first + BLOCK; i++)
        assert.ok(passable.has(axis === "v" ? `v:${x},${i}` : `h:${i},${y}`), `${at} ${key} is part of a whole block`);
    }
  }
});

test("perimeter authorship distinguishes deferral, opening guarantees, and occupancy hints", () => {
  const tiles = new Map(SIZES[0]!.library.tiles.map(tile => [tile.id, tile]));
  const sideKeys = [
    (i: number) => `h:0,${i}`, (i: number) => `v:6,${i}`,
    (i: number) => `h:6,${i}`, (i: number) => `v:0,${i}`,
  ];
  const values = (id: string, side: (i: number) => string) =>
    Array.from({ length: 6 }, (_, i) => tiles.get(id)!.segments?.[side(i)]?.passability);
  for (const id of ["field", "rubble-bank", "clear-rubble-bank", "clear-rubble-bend"])
    for (const side of sideKeys) assert.deepEqual(values(id, side), Array(6).fill("any"), `${id} defers explicitly`);
  for (const id of ["cover-ground", "ruins-ground", "hall-ground", "depot-ground", "compound-ground",
    "block-ground", "market-ground", "plant-ground", "checkpoint-ground", "park-ground",
    "arrival-ground", "departure-ground", "charging-ground", "transit-ground"])
    for (const side of sideKeys) assert.deepEqual(values(id, side), [
      ...Array(3).fill("not-passable-hint"), ...Array(3).fill("passable"),
    ], `${id} has an aligned three-cell opening`);
  for (const side of [sideKeys[0]!, sideKeys[3]!])
    assert.deepEqual(values("hut-quarter", side), Array(6).fill("any"), "hut joining sides defer");
  for (const side of [sideKeys[1]!, sideKeys[2]!])
    assert.deepEqual(values("hut-quarter", side), [
      ...Array(3).fill("not-passable-hint"), ...Array(3).fill("passable"),
    ], "hut open-facing sides retain their openings");
});

const base = SIZES[0]!;
test(`${base.name} game layouts place every class's quota, prove connected, and keep each core element class to its own instance`, () =>
  checkGameLayouts(base));
