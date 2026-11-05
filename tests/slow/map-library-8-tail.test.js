import test from 'node:test';
import { checkReportBatch } from '../helpers/map-library-game.js';

// The report batch's last ten 8-contestant maps; `map-library-8` runs the first ten (#807).
test('10 game-size maps with 8 contestants report no defects: library-10 to 19', () => checkReportBatch([10, 11, 12, 13, 14, 15, 16, 17, 18, 19], 8));
