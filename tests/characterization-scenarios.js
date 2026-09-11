// Captured against unchanged gameplay at 5dd7d61. Expected results are never updated by tests.
import { createHash } from 'node:crypto';
import { createGame, generateMap, joinGame, setInput, step, snapshot, playerView } from '../shared/simulation.js';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const seeds = [1, 9, 4217, 777];
export const mapHashes = () => Object.fromEntries(seeds.map(seed => [seed, hash(generateMap(seed))]));

export function botTrace(seed) {
  const s = createGame(seed), chunks = [];
  let digest = createHash('sha256');
  while (s.phase === 'live') {
    step(s);
    const frame = snapshot(s);
    // Every authoritative field, including bot paths and latched input, on every tick.
    digest.update(JSON.stringify(frame));
    for (const id of ['c0', 'g0', 'spectator']) digest.update(JSON.stringify(playerView(s, frame, id)));
    if (s.tick % 100 === 0 || s.phase !== 'live') {
      chunks.push({ tick: s.tick, hash: digest.digest('hex') }); digest = createHash('sha256');
    }
  }
  return chunks;
}

export function scriptedTrace() {
  const s = createGame(4217), frames = [];
  const p = joinGame(s, 'human', 'contestant', 'warden', 'Characterization');
  for (const other of s.players) { other.bot = false; other.input = {}; }
  s.map.items = []; s.map.traps = [];
  const g = s.players.find(p => p.role === 'gladiator'), rival = s.players[1];
  const capture = label => {
    const frame = snapshot(s);
    frames.push({ label, frame, views: ['human', rival.id, g.id, 'spectator'].map(id => playerView(s, frame, id)) });
  };
  const press = values => { setInput(s, p.id, { seq: p.lastSeq + 1, ...values }); step(s); };
  capture('joined');
  p.inventory = [{ kind: 'weapon', weaponType: 'pistol', ammo: 7 }, { kind: 'med', count: 2 }, { kind: 'med', count: 2 }, { kind: 'shield', count: 1 }, { kind: 'cell', charge: 0 }, null];
  p.hp = 45;
  setInput(s, p.id, { seq: 1, slot: 1, moveSlot: { from: 1, to: 2 } });
  setInput(s, p.id, { seq: 2, attack: true }); step(s); capture('latched-merge-and-use');
  press({ slot: 4, drop: true }); capture('drop');
  const dropped = s.map.items[0]; Object.assign(p, { x: dropped.x, y: dropped.y });
  for (let i = 0; i < 21; i++) step(s); capture('automatic-pickup');
  Object.assign(p, s.map.chargers[0]); press({ interact: true });
  for (let i = 0; i < 40; i++) step(s); capture('charging');
  press({ x: 1 }); capture('charge-cancel');
  Object.assign(p, s.map.chargers[0]); press({ interact: true });
  for (let i = 0; i < 100; i++) step(s); capture('charged');
  const door = s.map.gates.find(g => !g.locked);
  Object.assign(p, { x: door.x, y: door.y + 55 }); press({ interact: true }); capture('door-open');
  Object.assign(rival, { x: door.x, y: door.y }); press({ interact: true }); capture('door-occupied');
  rival.x += 200; press({ interact: true }); capture('door-close');
  Object.assign(p, s.map.spawns[0]); Object.assign(rival, { x: p.x + 32, y: p.y, hp: 1 });
  p.attackCd = 0; press({ slot: 0, attack: true, aim: 0 }); capture('pvp-death');
  Object.assign(g, { x: p.x + 32, y: p.y, hp: 1, maxHp: 400, level: 3, kills: 2 });
  p.attackCd = 0; press({ attack: true, aim: 0 }); capture('gladiator-death');
  p.input = {};
  for (let i = 0; i < 400; i++) step(s); capture('respawn');
  Object.assign(g, { x: p.x + 60, y: p.y });
  setInput(s, g.id, { seq: 1, aim: Math.PI, skill: true, attack: true }); step(s); capture('ability-and-melee');
  g.input = {}; Object.assign(g, s.map.stations[0]);
  setInput(s, g.id, { seq: 2, interact: true }); step(s); capture('transit');
  Object.assign(p, s.map.exit); press({ interact: true }); capture('extraction');
  s.slots = 0; step(s); capture('completion');
  return frames;
}
