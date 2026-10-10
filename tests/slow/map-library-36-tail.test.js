import test from 'node:test';
import { CHAIN_LIBRARIES } from '../../map/chain.ts';
import { checkLibrarySize } from '../helpers/map-library-sizes.js';
const library = CHAIN_LIBRARIES[2];
test(`${library.name}: game seeds 4–5 of 5 generate with no defects`, () => checkLibrarySize(library, [4, 5]));
