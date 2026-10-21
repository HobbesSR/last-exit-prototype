import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARIES, validateLibrary } from '../map/tools/core.ts';
import { renderableDraft } from '../map/tools/lab/draft-safety.ts';

/** The lab's draft safety gate is weaker than library validity (53, "Saved drafts"; #390). */

test('every bundled library is valid and passes the draft safety gate', () => {
  assert.ok(CHAIN_LIBRARIES.length > 0);
  for (const library of CHAIN_LIBRARIES) {
    assert.deepEqual(validateLibrary(library).errors, [], library.name);
    // A gate stricter than validateLibrary would refuse this library's import in the lab.
    assert.equal(renderableDraft(structuredClone(library)), true, library.name);
  }
});

test('the gate keeps incomplete work but refuses broken containers', () => {
  const [library] = CHAIN_LIBRARIES;
  const variant = (edit) => { const draft = structuredClone(library); edit(draft); return draft; };
  const incomplete = variant((draft) => {
    draft.unknownField = { keep: true };
    draft.tiles[0].orientations = [];
    draft.tiles[0].defaultCellClass = 'missing-class';
    draft.tileSets[0].members = ['absent-tile'];
    draft.setPieceClasses[0].quota = -1;
  });
  assert.equal(validateLibrary(incomplete).valid, false);
  assert.equal(renderableDraft(incomplete), true);
  for (const [name, edit] of [
    ['unsupported version', (draft) => { draft.version = 2; }],
    ['missing tiles', (draft) => { draft.tiles = null; }],
    ['null segment', (draft) => { draft.tiles[0].segments = { 'v:3,2': null }; }],
    ['malformed segment key', (draft) => { draft.tiles[0].segments = { oops: {} }; }],
    ['unknown cell mark', (draft) => { draft.tiles[0].cells = Array(6).fill('X.....'); draft.tiles[0].legend = {}; }],
    ['null slot', (draft) => { draft.setPieces[0].tiles = [null]; }],
  ]) assert.equal(renderableDraft(variant(edit)), false, name);
});
