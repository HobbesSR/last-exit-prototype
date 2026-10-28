import test from 'node:test';
import { zoneSizeName } from '../../map/live.ts';
import { playsToItsEnd, selectedSizes } from '../helpers/room-sizes.js';

// The legacy mover's rooms, which the harness pins. The shipped default is physics: room-sizes-physics.test.js.
for (const size of selectedSizes()) {
  test(`a ${zoneSizeName(size)} room plays to its end, records and replays`, async () => {
    await playsToItsEnd(size);
  });
}
