import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createGameRecord, disposePhysics, snapshot } from '../shared/simulation.ts';
import { allocateItemId, ensureItemIdentity, forkItemAllocation, initializeItemInstances, itemIdForLabel, itemLabel, registerItemLabel } from '../shared/item-instances.ts';
import { allocateInCore, ensureInCore, initItemAllocation, nextItemIdInCore } from '../shared/item-allocation-core.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { generatedMap } from './helpers/room-harness.js';
import { arena } from './helpers/arena.js';

test('initial instance IDs stay reserved after their items are consumed', () => {
  const s = createGameRecord(4217, generatedMap(), defaultContent());
  s.content = { ...s.content, itemInstances: { groundCapacity: 2 } };
  s.items = [{ id: 'instance-17', lineageId: 'instance-999', kind: 'weapon', weaponType: 'pistol', ammo: 1, x: 0, y: 0 }];
  for (const player of s.players) player.inventory = [null, null, null, null, null, null];
  s.players[0].inventory[0] = { kind: 'cell', charge: 0 };

  const before = s.itemSerial;
  delete s.scatterSerial; // Arrange first initialization of this legacy input.
  initializeItemInstances(s);
  assert.equal(s.scatterSerial, 19, 'only active legacy IDs reserve initial scatter phases');
  const root = s.items[0].lineageId, carried = s.players[0].inventory[0].instanceId;
  assert.ok(root >= before && carried > root, 'map items, disappeared roots and carried items share a monotonic domain');
  assert.equal(itemLabel(s, carried), 'instance-18');
  s.items.length = 0;
  const next = allocateItemId(s);
  assert.ok(next > carried);
  assert.equal(itemLabel(s, next), 'instance-19');
  assert.equal(itemIdForLabel(s, 'instance-999'), root, 'a lineage-only root stays reserved after its descendant disappears');
});

test('reload identities validate before normalization mutates records and join the numeric domain', () => {
  const fixture = id => {
    const { map } = arena({ cols: 4, rows: 3, spawns: [{ x: 100, y: 100 }] });
    const s = createGameRecord(17, map, { ...defaultContent(),
      roster: { contestants: ['A'], gladiators: [] }, discovery: false });
    s.items.push({ id: 'ground', kind: 'cell', charge: 1, x: 300, y: 200 });
    const p = s.players[0];
    p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 1, instanceId: 'held', lineageId: 'root' };
    p.reload = { slot: 0, instanceId: id, until: 20 };
    return { s, p };
  };
  const state = s => structuredClone({ items: s.items, players: s.players,
    itemSerial: s.itemSerial, scatterSerial: s.scatterSerial, registry: s.itemIdentities });
  for (const invalid of [undefined, null, '', 0, -1, 1.5, NaN, 999, Number.MAX_SAFE_INTEGER]) {
    const { s } = fixture(invalid), before = state(s);
    assert.throws(() => initializeItemInstances(s), /reload item identity|Unregistered item identity|counter exhausted/);
    assert.deepEqual(state(s), before, 'invalid reload references leave records, counters and the registry untouched');
  }
  for (const label of ['held', 'reload-only']) {
    const { s, p } = fixture(label);
    initializeItemInstances(s);
    assert.equal(typeof p.reload.instanceId, 'number');
    assert.equal(p.reload.instanceId, itemIdForLabel(s, label));
    assert.equal(snapshot(s).players[0].reload.instanceId, p.reload.instanceId);
    assert.ok(allocateItemId(s) > p.reload.instanceId);
  }
});

test('item allocation belongs to each game across core initialization and tentative forks', async () => {
  const content = { ...defaultContent(), roster: { contestants: ['A'], gladiators: [] }, discovery: false };
  const map = () => arena({ cols: 4, rows: 3, spawns: [{ x: 100, y: 100 }],
    items: [{ id: 'authored', kind: 'cell', charge: 1, x: 300, y: 200 }] }).map;
  const before = createGameRecord(17, map(), content);
  const assertUnbound = s => {
    assert.equal(s.itemAllocator, undefined);
    const serial = s.itemSerial, scatter = s.scatterSerial, item = { kind: 'cell', charge: 0 };
    assert.equal(allocateInCore(s), undefined);
    assert.equal(ensureInCore(s, item), undefined);
    assert.equal(nextItemIdInCore(s), undefined);
    assert.equal(s.itemSerial, serial);
    assert.equal(s.scatterSerial, scatter);
    assert.equal(item.instanceId, undefined);
    const id = allocateItemId(s);
    assert.equal(id, serial);
    assert.equal(itemLabel(s, id), `instance-${scatter}`);
  };
  assertUnbound(before);
  const game = await createGame(17, map(), content);
  try {
    const allocator = await initItemAllocation();
    assert.equal(game.itemAllocator, allocator);
    assert.equal(await initItemAllocation(), allocator, 'initialization returns the cached binding');
    assert.ok(Object.isFrozen(allocator));
    assertUnbound(before);
    assertUnbound(createGameRecord(17, map(), content));

    // Count calls while delegating to the real Rust binding: explicit records must
    // bind before normalization, and every operation must bypass setup allocation.
    const calls = { allocate: 0, ensure: 0, nextId: 0 };
    const tracked = Object.fromEntries(Object.keys(calls).map(key => [key, (...args) => {
      calls[key]++;
      return allocator[key](...args);
    }]));
    const bound = createGameRecord(17, map(), content, undefined, tracked);
    assert.ok(calls.nextId > 0, 'authored item normalization uses the supplied binding');
    const fork = forkItemAllocation(bound);
    assert.equal(fork.itemAllocator, tracked);
    const serial = bound.itemSerial, scatter = bound.scatterSerial;
    const id = allocateItemId(fork);
    assert.equal(id, serial);
    assert.equal(itemLabel(fork, id), `instance-${scatter}`);
    const item = { kind: 'cell', charge: 0 };
    ensureItemIdentity(fork, item);
    assert.equal(item.lineageId, item.instanceId);
    assert.equal(registerItemLabel(fork, 'fork-only'), item.instanceId + 1);
    assert.equal(calls.allocate, 1);
    assert.equal(calls.ensure, 1);
    assert.equal(bound.itemSerial, serial);
    assert.equal(bound.scatterSerial, scatter);
    assert.equal(itemIdForLabel(bound, 'fork-only'), undefined);
    assert.equal(itemIdForLabel(bound, `instance-${scatter}`), undefined);
    assert.equal(itemIdForLabel(fork, 'authored'), itemIdForLabel(bound, 'authored'));
  } finally {
    disposePhysics(game);
  }
});
