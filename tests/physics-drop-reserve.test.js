import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics, setInput, snapshot, stateOf, step } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE } from '../map/live.ts';
import { identifyItems } from './helpers/item-identity.js';
import { now } from './helpers/scenario.js';

// A real 12x6 map has hundreds of ground items and the world has 128 dynamic bodies for actors, props and loot.
// Without a reserve the items take every slot at tick 0 and a player's voluntary drop has nowhere to go (#523).
const map = generateLiveMap(4217, contentById('content-6'), DEFAULT_LIVE_ZONE_SIZE);

// A world without a drop reserve is content-6 with the field absent.
async function room(content = contentById('content-6')) {
  const s = await createGame(4217, structuredClone(map), content);
  const p = s.players.find(q => q.role === 'contestant');
  p.bot = false;
  p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 48, instanceId: 'held-1', lineageId: 'held-1' };
  identifyItems(s);
  p.selectedSlot = 0;
  return { s, r: physicsRuntime(s), p };
}

test('content without a reserve fills the world with map items, so no drop can be admitted', async () => {
  const noReserve = structuredClone(contentById('content-6'));
  delete noReserve.worldPhysics.dropReserve;
  const { s, r, p } = await room(noReserve);
  try {
    assert.ok(s.items.length > 128, 'a real map has more items than the world has slots');
    assert.equal(r.world.canAddBodies(1), false, 'the world is full at tick 0');
    // The refusal itself is the core's (`item_tests.rs`, `an_optional_drop_with_no_body_slot_or_no_clear_spot_is_refused_and_keeps_the_inventory`).
    // Here the content's own sizing is what leaves no slot: the player's drop, played on the started match, changes nothing.
    const held = p.inventory[0].weaponType;
    step(s); // the first tick admits the map's items, which take every slot
    setInput(s, p.id, { seq: 1, drop: true }); step(s);
    assert.equal(now(s, p).inventory[0]?.weaponType, held, 'an optional drop with no slot preserves the inventory');
    assert.equal(stateOf(s).items.some(item => item.droppedBy === p.id), false);
  } finally { disposePhysics(s); }
});

test('the shipped content leaves a reserve, so a player can drop and the item gets a body', async () => {
  const { s, r, p } = await room();
  try {
    const reserve = s.content.worldPhysics.dropReserve, free = () => 128 - r.world.counts().dynamic;
    assert.ok(reserve > 0 && free() >= reserve, `ordinary items leave the reserve free: ${free()} of ${reserve}`);
    const held = p.inventory[0].instanceId;
    setInput(s, p.id, { seq: 1, drop: true }); step(s);
    assert.equal(now(s, p).inventory[0], null, 'the drop empties the slot');
    assert.ok(stateOf(s).items.some(item => item.id === held), 'and the item is on the ground');
    const frame = snapshot(s);
    assert.ok(frame.bodies.some(body => body.owner.kind === 'item' && body.owner.itemId === held), 'with a body, admitted from the reserve');
  } finally { disposePhysics(s); }
});

test('a reserve that is not a small nonnegative integer is refused before a solver is built', async () => {
  for (const dropReserve of [-1, 1.5, 97, Number.NaN]) {
    const content = structuredClone(contentById('content-6'));
    content.worldPhysics.dropReserve = dropReserve;
    await assert.rejects(() => createGame(4217, structuredClone(map), content), /invalid world physics profile/, String(dropReserve));
  }
});
