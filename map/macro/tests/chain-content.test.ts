/**
 * B4 (#97): the chain's own library, `content/chain-library.json`, authored against the
 * catalogue's minimal set (54). Its region types are checked against the game's registry
 * in the root `tests/map-library.test.js`, since macro doesn't import micro (50).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { orientDesign, parseKey } from "../src/chain/declared-grid.ts";
import { CHAIN_TILE_SIZE, validateLibrary } from "../src/chain/library.ts";
import type { ChainLibrary } from "../src/chain/library.ts";
import { placement } from "../src/chain/placement.ts";
import { proof, proofViolations } from "../src/chain/proof.ts";
import { portalViolations, regions } from "../src/chain/regions.ts";
import { resolution } from "../src/chain/resolution.ts";
import type { ChainParams, Orientation } from "../src/chain/types.ts";

const LIBRARY = JSON.parse(readFileSync(new URL("../content/chain-library.json", import.meta.url), "utf8")) as ChainLibrary;
/** The catalogue's minimal set (54), which B3 built. */
const MINIMAL_SET = new Set(["open", "cover", "rubble", "hut", "arrival", "departure", "charging"]);
const GAME: ChainParams = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
/** The width of the narrowest passage the content may form: a doorway plus one, as `cover`'s aisle (54). */
const BLOCK = 3;

test("the library is valid, and paints only the catalogue's minimal set", () => {
  assert.deepEqual(validateLibrary(LIBRARY, MINIMAL_SET), { valid: true, errors: [] });
  assert.deepEqual(new Set(Object.values(LIBRARY.cellClasses).map((c) => c.regionType)), MINIMAL_SET);
});

test("every design keeps its classes and passable stretches on a three-cell grid", () => {
  // Class boundaries on the grid keep every passage at least three cells wide, so open ground
  // has no neck a hunter can't cross (17 M9), and the sampled route check sees every passage.
  // A passable stretch made of whole blocks splits, where the class across changes, into
  // portals no shorter than a block, so the portal rule never refuses one.
  for (const design of LIBRARY.tiles) for (const orientation of design.orientations) {
    const { cells, segments } = orientDesign(design, orientation as Orientation), at = `${design.id}@${orientation}`;
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

test("game layouts place every class's quota, prove connected, and keep each core element class to its own instance", () => {
  for (const seed of ["library-1", "library-2", "library-3", "library-4"]) {
    const layout = placement(seed, GAME, LIBRARY);
    const found = regions(resolution(layout, LIBRARY), layout.seed);
    assert.deepEqual(portalViolations(found), [], seed);
    assert.deepEqual(proofViolations(proof(found), found, LIBRARY), [], seed);
    for (const { id, quota } of LIBRARY.setPieceClasses)
      assert.equal(layout.setPieces.filter((p) => p.setPieceClass === id).length, quota, `${seed} ${id}`);
    // Each owning class has quota 1, and its pieces form one region of its core element class.
    for (const type of ["arrival", "departure", "charging"])
      assert.equal(found.regions.filter((r) => r.class === type).length, 1, `${seed} ${type}`);
  }
});
