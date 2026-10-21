import test from 'node:test';
import assert from 'node:assert/strict';
import { describeContent, readPresentation, resolveRecordingPresentation, LEGACY_DISPLAY_ID } from '../shared/presentation.ts';
import { contentById, defaultContent } from '../shared/simulation/content.ts';
import { createGame } from '../shared/simulation.ts';

const frozenThrough = value => Object.isFrozen(value) && Object.values(value).every(v => !v || typeof v !== 'object' || frozenThrough(v));

test('a descriptor lists display data in table order and nothing private', () => {
  const p = describeContent(contentById('content-1'));
  assert.deepEqual(p, {
    contentId: 'content-1',
    weapons: [{ id: 'pistol', name: 'Pistol', ammo: 48 }, { id: 'rifle', name: 'Rifle', ammo: 90 }, { id: 'scattergun', name: 'Scattergun', ammo: 24 }],
    kits: [{ id: 'warden', name: 'Warden', skill: 'Shockwave' }, { id: 'specter', name: 'Specter', skill: 'Pulse scan' }, { id: 'striker', name: 'Striker', skill: 'Overdrive' }],
    capacity: { contestant: 8, gladiator: 2 },
    durationTicks: 12000,
    cellChargeTicks: 100,
  });
  assert.equal(describeContent(defaultContent()).capacity.gladiator, 3);
  assert.ok(frozenThrough(p));
});

test('describing content consumes no randomness and leaves the match as it was', () => {
  const s = createGame(4217), before = structuredClone({ rng: s.rng, serial: s.serial, players: s.players.map(q => q.id) });
  describeContent(s.content);
  assert.deepEqual({ rng: s.rng, serial: s.serial, players: s.players.map(q => q.id) }, before);
});

test('reading a descriptor validates the whole shape and copies it', () => {
  const good = describeContent(defaultContent());
  const copy = readPresentation({ ...structuredClone(good), extra: 'ignored' });
  assert.deepEqual(copy, good);
  assert.ok(frozenThrough(copy));
  assert.equal(readPresentation(good, 'content-2')?.contentId, 'content-2');
  assert.equal(readPresentation(good, 'content-1'), null, 'expected id must match');
  const unknown = readPresentation({ ...structuredClone(good), contentId: 'brand-new' }, 'brand-new');
  assert.equal(unknown?.contentId, 'brand-new', 'unknown content is still describable');
  assert.equal(readPresentation({ ...structuredClone(good), weapons: [{ id: 'pistol', name: 'P', ammo: 0 }] })?.weapons[0].ammo, 0, 'zero ammo is valid');
  const broken = [
    null, 'x', [], {},
    { ...good, contentId: '' },
    { ...good, weapons: [...good.weapons, good.weapons[0]] },
    { ...good, weapons: [{ id: 'pistol', name: 1, ammo: 3 }] },
    { ...good, weapons: [{ id: 'pistol', name: 'P', ammo: -1 }] },
    { ...good, weapons: [{ id: 'pistol', name: 'P', ammo: 1.5 }] },
    { ...good, weapons: [{ id: '', name: 'P', ammo: 1 }] },
    { ...good, kits: [{ id: 'warden', name: 'W' }] },
    { ...good, kits: { warden: { name: 'W', skill: 'S' } } },
    { ...good, capacity: { contestant: 8 } },
    { ...good, capacity: { contestant: 8, gladiator: -1 } },
    { ...good, durationTicks: 0 },
    { ...good, cellChargeTicks: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const value of broken) assert.equal(readPresentation(value), null, JSON.stringify(value));
});

test('recording headers resolve embedded, retained, legacy and unknown display in order', () => {
  const embedded = { ...structuredClone(describeContent(defaultContent())), contentId: 'future-9' };
  embedded.weapons[0].name = 'Future pistol';
  const resolve = header => { const r = resolveRecordingPresentation(header); return [r.source, r.presentation?.contentId ?? null]; };
  assert.deepEqual(resolve({ contentId: 'future-9', presentation: embedded }), ['embedded', 'future-9']);
  assert.equal(resolveRecordingPresentation({ contentId: 'future-9', presentation: embedded }).presentation.weapons[0].name, 'Future pistol');
  assert.deepEqual(resolve({ contentId: 'content-1' }), ['retained', 'content-1']);
  assert.deepEqual(resolve({ contentId: 'content-2' }), ['retained', 'content-2']);
  assert.deepEqual(resolve({ contentId: 'content-1', presentation: embedded }), ['retained', 'content-1'], 'a mismatched descriptor is ignored');
  assert.deepEqual(resolve({ contentId: 'content-2', presentation: { contentId: 'content-2' } }), ['retained', 'content-2'], 'so is an invalid one');
  assert.deepEqual(resolve({ contentId: 'future-9' }), ['unknown', null]);
  assert.deepEqual(resolve({ contentId: 'future-9', presentation: { ...embedded, durationTicks: -1 } }), ['unknown', null]);
  for (const contentId of ['', 7, null, 'legacy-display', 'toString', '__proto__']) assert.deepEqual(resolve({ contentId }), ['unknown', null], String(contentId));
  const legacy = resolveRecordingPresentation({ schema: 2 });
  assert.equal(legacy.source, 'legacy');
  assert.equal(legacy.presentation.contentId, LEGACY_DISPLAY_ID);
  assert.deepEqual([legacy.presentation.durationTicks, legacy.presentation.cellChargeTicks, legacy.presentation.weapons[0].ammo, legacy.presentation.kits.length], [2400, 100, 48, 3]);
  assert.deepEqual(resolve(null), ['legacy', LEGACY_DISPLAY_ID]);
});
