import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, KITS, WEAPONS, PHASES, AMMO_FAMILIES, ITEM_KINDS, BODY_KINDS,
  SHAPE_KINDS, EFFECT_KINDS, TRAP_KINDS, EVENT_KINDS, PLAYER_STATUSES,
} from '../shared/enum-tables.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { describeContent } from '../shared/presentation.ts';
import { syncWeapon } from '../shared/equipment.ts';
import { createGameRecord } from '../shared/simulation/state.ts';
import { arena } from './helpers/arena.js';

test('closed enum tables preserve the established vocabulary order', () => {
  for (const table of [ROLES, KITS, WEAPONS, PHASES, AMMO_FAMILIES, ITEM_KINDS, BODY_KINDS, SHAPE_KINDS, EFFECT_KINDS, TRAP_KINDS, EVENT_KINDS, PLAYER_STATUSES]) {
    assert.equal(Object.isFrozen(table), true);
  }
  assert.deepEqual(ROLES, ['contestant', 'gladiator']);
  assert.deepEqual(KITS, ['warden', 'specter', 'striker', 'hook']);
  assert.deepEqual(WEAPONS, ['pistol', 'rifle', 'scattergun']);
  assert.deepEqual(PHASES, ['live', 'finished']);
  assert.deepEqual(AMMO_FAMILIES, ['pistol', 'rifle', 'shell']);
  assert.deepEqual(ITEM_KINDS, ['weapon', 'med', 'shield', 'cell', 'access', 'ammo']);
  assert.deepEqual(BODY_KINDS, ['actor', 'prop', 'static']);
  assert.deepEqual(SHAPE_KINDS, ['circle', 'box', 'convex']);
  assert.deepEqual(EFFECT_KINDS, ['shock', 'scan', 'slash', 'loot', 'upgrade', 'rail', 'charge', 'grapple']);
  assert.deepEqual(TRAP_KINDS, ['mine', 'turret', 'flame', 'spider']);
  assert.deepEqual(EVENT_KINDS, ['pod_powered', 'cell_charged', 'eliminated', 'respawned', 'match_finished']);
  // Sent as indices by the descriptor codec (#1131): reordering it changes the wire's meaning.
  assert.deepEqual(PLAYER_STATUSES, ['active', 'eliminated', 'respawning', 'escaped', 'stranded', 'transit']);
});

test('content descriptors use explicit order and reject unknown content keys', () => {
  const content = defaultContent();
  const presentation = describeContent({ ...content, weapons: { scattergun: content.weapons.scattergun, pistol: content.weapons.pistol, rifle: content.weapons.rifle } });
  assert.deepEqual(presentation.weapons.map(({ id }) => id), WEAPONS);
  const player = { inventory: [{ kind: 'weapon', weaponType: 'scattergun' }], selectedSlot: 0 };
  syncWeapon(player, { scattergun: content.weapons.scattergun, pistol: content.weapons.pistol, rifle: content.weapons.rifle });
  assert.equal(player.weapon, 3, 'weapon codes are independent of content object insertion order');
  assert.throws(() => describeContent({ ...content, weapons: { ...content.weapons, unknown: content.weapons.pistol } }), /Unknown weapon/);
  const { map } = arena({ cols: 2, rows: 2 });
  assert.throws(() => createGameRecord(1, map, { ...content, weapons: { ...content.weapons, unknown: content.weapons.pistol } }), /Unknown weapon/);
  assert.throws(() => createGameRecord(1, map, { ...content, kits: { ...content.kits, unknown: content.kits.warden } }), /Unknown kit/);
});
