/**
 * Checks any chain stage can be held to (51 principles 1 and 3, 53 "One seed decides
 * the whole map"). Each throws an assertion error naming the stage on failure.
 */
import assert from "node:assert/strict";

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
