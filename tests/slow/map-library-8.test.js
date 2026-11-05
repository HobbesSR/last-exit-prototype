import test from 'node:test';
import { checkReportBatch } from '../helpers/map-library-game.js';

// The report batch's first ten 8-contestant maps; `map-library-8-tail` runs the other ten (#807).
test('10 game-size maps with 8 contestants report no defects: library-0 to 9', () => checkReportBatch([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 8));
