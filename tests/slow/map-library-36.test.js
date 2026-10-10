import test from 'node:test';
import { CHAIN_LIBRARIES } from '../../map/chain.ts';
import { checkLibrarySize } from '../helpers/map-library-sizes.js';
const library = CHAIN_LIBRARIES[2];
test(`${library.name}: game seeds 1–3 of 5 generate with no defects`, () => checkLibrarySize(library, [1, 2, 3]));
