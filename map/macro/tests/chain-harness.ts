/**
 * Checks any generation chain stage can be held to (51.1 principles 1 and 3, 53 "One seed decides
 * the whole map"). Each throws an assertion error naming the stage on failure.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ChainLibrary } from "../src/chain/library.ts";
import type { ChainParams } from "../src/chain/types.ts";

/** The 12 x 6 game params the macro tests generate at: two exits, eight contestants, three hunters. */
export const GAME: ChainParams = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };

/** The stored placement library the macro tests place with (tests/fixtures/chain-placement-library.json). */
export const LIBRARY = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;

/** A stage leaves its inputs as they were: deep-equal before and after it runs. */
export function assertPure<I extends readonly unknown[], O>(name: string, stage: (...inputs: I) => O, ...inputs: I): O {
  const before = structuredClone(inputs);
  const output = stage(...inputs);
  assert.deepEqual(inputs, before, `${name} changed its inputs`);
  return output;
}

/**
 * The same inputs give deep-equal outputs. Each run gets its own copy, so a stage can't
 * pass by returning something it cached on an input's identity.
 */
export function assertDeterministic<I extends readonly unknown[], O>(name: string, stage: (...inputs: I) => O, ...inputs: I): O {
  const first = stage(...structuredClone(inputs));
  assert.deepEqual(stage(...structuredClone(inputs)), first, `${name} gave different outputs for the same inputs`);
  return first;
}

/**
 * A view is recomputable from objects alone. The objects go through JSON first, as a
 * save would take them, so a view that leans on anything not saved, or objects that
 * aren't plain data, fail here.
 */
export function assertRecomputable<I extends readonly unknown[], V>(name: string, view: V, derive: (...objects: I) => V, ...objects: I): void {
  const saved = JSON.parse(JSON.stringify(objects)) as I;
  assert.deepEqual(saved, objects, `${name}: its objects don't survive saving`);
  assert.deepEqual(derive(...saved), view, `${name} isn't recomputable from its objects`);
}
