import test from 'node:test';
import { CHAIN_LIBRARIES } from '../../map/chain.ts';
import { checkLibrarySize } from '../helpers/map-library-sizes.js';
const library = CHAIN_LIBRARIES[1];
test(`${library.name}: 5 game maps generate with no defects`, () => checkLibrarySize(library));
