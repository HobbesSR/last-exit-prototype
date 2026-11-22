import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, setInput, snapshot, step } from '../shared/simulation.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { identifyItems, registeredItemId } from './helpers/item-identity.js';
import { contentById } from '../shared/simulation/content.ts';
import { automaticPickups } from '../shared/simulation/loot.ts';
import { collectAmmo, collectInstanceEquipment } from '../shared/equipment.ts';
import { forkItemAllocation, registerItemLabel } from '../shared/item-instances.ts';
import { addItems, draftItem, groundItem, removeItem, settledItem } from '../shared/simulation/ground-items.ts';
import { interact } from '../shared/simulation/interactions.ts';
import { setDoor } from '../shared/simulation/doors.ts';
import { nearbyGate } from '../shared/gate-query.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { openArea, openField } from './helpers/arena.js';
import { stagePhysics } from './helpers/scenario.js';

// Phase 6's pickups run in the core (`rust/core/src/phase_six.rs`, #1230, docs/27 step 5e.1). The TypeScript transfer
// (`collectInstanceEquipment`, `collectAmmo` in `equipment.ts`) stays for scenario and setup callers (27's retained-copy
// ledger), so this holds the two equal: each case runs the TypeScript on a staged copy of the player and the record,
// then the core's pickup on the game, and compares the inventory as JSON (so key order counts), the reserves, the keys,
// the record left on the ground and both item counters.
const arena = () => ({ width: 800, height: 400, playableArea: openArea(800, 400, 100),
  buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [], sensors: [], items: [], traps: [],
  entry: { x: 60, y: 200 }, exit: { x: 750, y: 200 }, spawns: [{ x: 300, y: 200 }] });
const content = (id, reloading) => {
  const c = { ...structuredClone(contentById(id)), roster: { contestants: ['A'], gladiators: [] }, discovery: false };
  if (!reloading) delete c.reloading;
  return c;
};

/** The TypeScript rule a pickup ran before #1230, over the retained transfer: what the record leaves on the ground. */
function reference(s, p, item) {
  const draft = draftItem(item);
  if (item.kind === 'access') p.keys++;
  if (item.kind === 'ammo' && !(s.content.reloading && collectAmmo(s, p, draft, item))) return settledItem(item, draft);
  if (['weapon', 'med', 'shield', 'cell'].includes(item.kind) && !collectInstanceEquipment(s, p, draft, item)) return settledItem(item, draft);
  return null;
}

const cases = [
  ['a weapon into an empty slot', p => { p.inventory = [null, null, null, null, null, null]; }, { kind: 'weapon', weaponType: 'rifle', ammo: 5 }],
  ['a duplicate weapon', p => { p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 3 }; }, { kind: 'weapon', weaponType: 'pistol', ammo: 30 }],
  ['a duplicate weapon of another quality', p => { p.inventory[0] = { kind: 'weapon', weaponType: 'pistol', ammo: 3, quality: 2 }; }, { kind: 'weapon', ammo: 7 }],
  ['a stack merged in part', p => { p.inventory[2] = { kind: 'med', count: 2 }; }, { kind: 'med', count: 3 }],
  ['an oversized stack split', p => { p.inventory = [null, null, null, null, null, null]; }, { kind: 'shield', count: 5, quality: 3 }],
  ['a cell, with the carried items given identities', p => { p.inventory[4] = { kind: 'med', count: 1 }; }, { kind: 'cell', charge: 12 }],
  ['ammo filling a reserve in part', p => { if (p.reserves) p.reserves.pistol = p.reserves.pistol ?? 0; }, { kind: 'ammo', family: 'pistol', count: 500 }],
  ['ammo taken whole', () => {}, { kind: 'ammo', family: 'rifle', count: 1 }],
  ['an access key', () => {}, { kind: 'access' }],
  ['an invalid weapon left alone', () => {}, { kind: 'weapon', weaponType: 'pistol', ammo: 1e6 }],
  ['a full inventory', p => { p.inventory = Array.from({ length: 6 }, () => ({ kind: 'weapon', weaponType: 'rifle', ammo: 1 })); }, { kind: 'shield', count: 1 }],
];

for (const [name, reloading] of [['content-6', false], ['content-ammo-1', true]]) {
  test(`the core's pickups equal the retained TypeScript transfer (${name})`, async () => {
    const s = await createGame(17, arena(), content(name, reloading));
    try {
      const p = s.players[0];
      p.bot = false;
      let n = 0;
      for (const [label, arrange, fields] of cases) {
        p.inventory = [{ kind: 'weapon', weaponType: 'pistol', ammo: 12 }, null, null, null, null, null];
        if (p.reserves) p.reserves = { pistol: 10, rifle: 95, shell: 0 };
        p.keys = 0; p.selectedSlot = 0;
        arrange(p);
        const item = { id: registerItemLabel(s, `case-${n++}`), x: p.x, y: p.y, ...fields };
        addItems(s, item);
        // The TypeScript, on a staged player and allocation.
        const stage = forkItemAllocation(s), staged = structuredClone(p);
        stage.players = s.players.map(q => q === p ? staged : q);
        const left = reference(stage, staged, item);
        // The core, on the game.
        automaticPickups(s, p, { sneak: true });
        const now = groundItem(s, item.id);
        assert.equal(JSON.stringify(p.inventory), JSON.stringify(staged.inventory), `${label}: the inventory`);
        assert.deepEqual([p.reserves, p.keys, p.selectedSlot, p.weapon], [staged.reserves, staged.keys, staged.selectedSlot, staged.weapon], `${label}: the player`);
        assert.equal(JSON.stringify(now ?? null), JSON.stringify(left), `${label}: the record left`);
        assert.deepEqual([s.itemSerial, s.scatterSerial], [stage.itemSerial, stage.scatterSerial], `${label}: the counters`);
        if (now) removeItem(s, now);
      }
    } finally { disposePhysics(s); }
  });
}

test('a sensor reveals a contestant in reach unless it sneaks or is cloaked', async () => {
  const map = { ...arena(), sensors: [{ x: 400, y: 200 }] };
  const s = await createGame(17, map, content('content-6', false));
  try {
    const p = s.players[0];
    p.revealed = 0;
    automaticPickups(s, p, { sneak: true });
    assert.equal(p.revealed, 0, 'sneaking');
    p.cloak = 5;
    automaticPickups(s, p, {});
    assert.equal(p.revealed, 0, 'cloaked');
    p.cloak = 0;
    automaticPickups(s, p, {});
    assert.equal(p.revealed, 65);
  } finally { disposePhysics(s); }
});

test('the core picks the gate nearbyGate picks, from its own gate buckets', async () => {
  // The core finds the gates near an interacting actor in its gate set (`gates_near`), not through `gatesNear`. Doors of
  // several sizes, equal distances (map order breaks the tie) and a door behind another, closed, door.
  const door = (id, x, y, extra = {}) => ({ id, x, y, w: 26, h: 54, open: false, locked: false, kind: 'door', ...extra });
  const gates = [door('a', 3000, 560), door('b', 3060, 560), door('c', 3030, 640, { w: 60, h: 10 }), door('d', 2970, 600, { w: 10, h: 90 }),
    door('e', 3120, 560), door('f', 2940, 520, { w: 40, h: 40 })];
  const { map } = openField(4000, { gates });
  const actors = [{ role: 'contestant', bot: false, x: 3000, y: 576 }, { role: 'gladiator', bot: false, x: 200, y: 900 }];
  const { s, players: [p] } = await stagePhysics(map, { content: defaultContent(), actors });
  try {
    let found = 0;
    for (let x = 2860; x <= 3200; x += 17) for (let y = 470; y <= 720; y += 13) {
      Object.assign(p, { x, y });
      const expected = nearbyGate(s.map, p, { accepts: g => !p.bot || !g.open, order: 'nearest' });
      interact(s, p);
      const opened = s.map.gates.filter(g => g.open);
      assert.deepEqual(opened.map(g => g.id), expected ? [expected.id] : [], `at ${x},${y}`);
      if (expected) { found++; setDoor(s, s.map.gates.indexOf(expected), { open: false }); }
    }
    assert.ok(found > 100, `the cases reach gates (${found})`);
  } finally { disposePhysics(s); }
});
