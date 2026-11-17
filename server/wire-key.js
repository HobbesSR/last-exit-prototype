import { randomFillSync } from 'node:crypto';
import { WIRE_ID_ROUNDS } from '../shared/simulation/wire-ids.ts';

/**
 * A fresh key for one match's (or waiting yard's) outward IDs (#1164, 24.4), from the secure random source.
 * Never derived from the match seed or the gameplay RNG, and never recorded, logged or sent.
 */
export const randomWireIdKey = () => Array.from(randomFillSync(new Uint32Array(WIRE_ID_ROUNDS)));
