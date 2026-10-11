import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHAIN_TILE_SIZE, resolveLibrary } from "../src/chain/library.ts";
import type { ChainLibrary } from "../src/chain/library.ts";
import { placement } from "../src/chain/placement.ts";
import { proof, proofViolations } from "../src/chain/proof.ts";
import { portalViolations, regions } from "../src/chain/regions.ts";
import { resolution } from "../src/chain/resolution.ts";
import type { ChainParams } from "../src/chain/types.ts";

const content = (name: string): unknown => JSON.parse(readFileSync(new URL(`../content/${name}.json`, import.meta.url), "utf8"));
const MODULES = {
  "common-primitives@4": content("common-primitives@4"), "common-set-pieces@4": content("common-set-pieces@4"),
  "district-set-pieces@3": content("district-set-pieces@3"),
};
const OWNERS = { arrival: "start", departure: "end", charging: "charger" };
/** Each size's distribution from 52 and 55, and the original number of placement seeds. */
export const SIZES = [
  { name: "diamond-12x6", quotas: { start: 1, end: 1, enormous: 3, medium: 4, small: 10, charger: 1, transit: 6 }, seeds: 4 },
  { name: "diamond-24x12", quotas: { start: 1, end: 1, enormous: 3, medium: 12, small: 32, charger: 1, transit: 6 }, seeds: 2 },
  { name: "diamond-36x18", quotas: { start: 1, end: 1, enormous: 3, medium: 8, small: 44, charger: 1, transit: 6 }, seeds: 1 },
].map((size) => ({ ...size, library: resolveLibrary(content(size.name), MODULES) }));

type Size = typeof SIZES[number];
const gameParams = (library: ChainLibrary): ChainParams => ({
  zoneWidth: library.zoneWidth, zoneHeight: library.zoneHeight, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09,
});

export function checkGameLayouts({ library: LIBRARY, quotas: QUOTAS, seeds }: Size): void {
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
}
