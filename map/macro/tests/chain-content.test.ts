/**
 * B4 (#97): the chain's own libraries, `content/diamond-12x6.json` and, since S6 (#171),
 * `diamond-24x12.json` and `diamond-36x18.json`, authored against the catalogue (54), with
 * set pieces on the old library's footprints since S5 (#170). Their region types are checked
 * against the game's registry in the root `tests/map-library.test.js`, since macro doesn't
 * import micro (50).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { orientDesign, parseKey } from "../src/chain/declared-grid.ts";
import { CHAIN_TILE_SIZE, resolveLibrary, validateLibrary } from "../src/chain/library.ts";
import type { ChainLibrary } from "../src/chain/library.ts";
import { placement } from "../src/chain/placement.ts";
import { proof, proofViolations } from "../src/chain/proof.ts";
import { portalViolations, regions } from "../src/chain/regions.ts";
import { resolution } from "../src/chain/resolution.ts";
import type { ChainParams, Orientation } from "../src/chain/types.ts";

const content = (name: string): unknown => JSON.parse(readFileSync(new URL(`../content/${name}.json`, import.meta.url), "utf8"));
const MODULES = {
  "common-primitives@2": content("common-primitives@2"), "common-set-pieces@2": content("common-set-pieces@2"),
  "district-set-pieces@1": content("district-set-pieces@1"),
};
/** The catalogue (54): its minimal set, the types B3 built, and the types S4 drafted. */
const CATALOGUE = new Set([
  "open", "cover", "rubble", "hut", "arrival", "departure", "charging", "transit",
  "ruins", "hall", "depot", "compound", "block", "market", "plant", "checkpoint", "park",
]);
/** The width of the narrowest passage the content may form: a doorway plus one, as `cover`'s aisle (54). */
const BLOCK = 3;
const OWNERS = { arrival: "start", departure: "end", charging: "charger" };
/**
 * Each size's game distribution as 52 and 55 record it, independent of the authored quotas,
 * and the seeds its layouts are checked on: fewer at the larger sizes, which place slower.
 */
const SIZES = [
  { name: "diamond-12x6", quotas: { start: 1, end: 1, enormous: 3, medium: 4, small: 10, charger: 1, transit: 6 }, seeds: 4 },
  { name: "diamond-24x12", quotas: { start: 1, end: 1, enormous: 3, medium: 12, small: 32, charger: 1, transit: 6 }, seeds: 2 },
  { name: "diamond-36x18", quotas: { start: 1, end: 1, enormous: 3, medium: 8, small: 44, charger: 1, transit: 6 }, seeds: 1 },
].map((size) => ({ ...size, library: resolveLibrary(content(size.name), MODULES) }));
const gameParams = (library: ChainLibrary): ChainParams => ({
  zoneWidth: library.zoneWidth, zoneHeight: library.zoneHeight, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09,
});

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

test("every design keeps its classes and passable stretches on a three-cell grid", () => {
  // Class boundaries on the grid keep every passage at least three cells wide, so open ground
  // has no neck a hunter can't cross (17 M9), and the sampled route check sees every passage.
  // A passable stretch made of whole blocks splits, where the class across changes, into
  // portals no shorter than a block, so the portal rule never refuses one.
  for (const { library: LIBRARY } of SIZES) for (const design of LIBRARY.tiles) for (const orientation of design.orientations) {
    const { cells, segments } = orientDesign(design, orientation as Orientation), at = `${design.id}@${orientation}`;
    // A later per-cell resolution of `any` could break the block-width argument.
    assert.ok(cells.every(cell => CATALOGUE.has(cell)), `${at} paints concrete classes`);
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

for (const { name, library: LIBRARY, quotas: QUOTAS, seeds } of SIZES) test(`${name} game layouts place every class's quota, prove connected, and keep each core element class to its own instance`, () => {
  const GAME = gameParams(LIBRARY), columns = 5 * LIBRARY.zoneWidth;
  for (const seed of ["library-1", "library-2", "library-3", "library-4"].slice(0, seeds)) {
    const layout = placement(seed, GAME, LIBRARY);
    const resolved = resolution(layout, LIBRARY), found = regions(resolved, layout.seed);
    assert.deepEqual(portalViolations(found), [], seed);
    assert.deepEqual(proofViolations(proof(found), found, LIBRARY), [], seed);
    for (const [id, quota] of Object.entries(QUOTAS))
      assert.equal(layout.setPieces.filter((p) => p.setPieceClass === id).length, quota, `${seed} ${id}`);
    assert.equal(new Set(layout.setPieces.filter(p => p.setPieceClass === "enormous").map(p => p.setPiece)).size, 3, `${seed} distinct enormous pieces`);
    // Each owning class has quota 1, and its pieces form one region of its core element class.
    for (const [type, owner] of Object.entries(OWNERS)) {
      const matching = found.regions.filter(r => r.class === type);
      assert.equal(matching.length, 1, `${seed} ${type}`);
      const instance = layout.setPieces.find(p => p.setPieceClass === owner)!;
      const slots = new Set(instance.slots.map(s => `${s.col},${s.row}`));
      for (const cell of matching[0]!.cells) {
        const col = Math.floor((cell % resolved.width) / CHAIN_TILE_SIZE);
        const row = Math.floor(Math.floor(cell / resolved.width) / CHAIN_TILE_SIZE);
        assert.ok(slots.has(`${col},${row}`), `${seed} ${type} stays in its ${owner} instance`);
      }
    }
    const transitInstances = layout.setPieces.filter(p => p.setPieceClass === "transit");
    const transitRegions = found.regions.filter(r => r.class === "transit");
    assert.equal(transitRegions.length, 6, `${seed}: separate transit regions`);
    const anchors = transitInstances.map(instance => Math.min(...instance.slots.map(s => s.col))).sort((a, b) => a - b);
    assert.ok(anchors.at(-1)! - anchors[0]! >= columns * 25 / 60, `${seed}: stations span the map length`);
    for (const region of transitRegions) {
      const owners = transitInstances.filter(instance => {
        const slots = new Set(instance.slots.map(s => `${s.col},${s.row}`));
        return region.cells.some(cell => slots.has(`${Math.floor((cell % resolved.width) / CHAIN_TILE_SIZE)},${Math.floor(Math.floor(cell / resolved.width) / CHAIN_TILE_SIZE)}`));
      });
      assert.equal(owners.length, 1, `${seed}: a transit region belongs to one instance`);
      assert.ok(region.cells.every(cell => {
        const col = Math.floor((cell % resolved.width) / CHAIN_TILE_SIZE);
        const row = Math.floor(Math.floor(cell / resolved.width) / CHAIN_TILE_SIZE);
        return owners[0]!.slots.some(slot => slot.col === col && slot.row === row);
      }), `${seed}: transit cannot merge into another region`);
    }
  }
});
