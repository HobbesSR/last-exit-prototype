import test from 'node:test';
import assert from 'node:assert/strict';
import { OWN_FILE, byType, checkLargeBriefs } from '../helpers/large-briefs.js';

// The large-briefs check for the types too costly to share micro-large-briefs.test.js's 60 s (#849): park's
// 87-portal, 5,760-cell brief takes about 40 s to build since the matched libraries.
for (const type of OWN_FILE) test(`large briefs: ${type} builds what the larger sizes hand it`, () => {
  assert.ok(byType.has(type), `the stored briefs hold a ${type} brief`);
  checkLargeBriefs(type, byType.get(type));
});
