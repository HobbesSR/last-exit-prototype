import { createGame } from './state.ts';
import { bodyRadius, canOccupy, reachClear } from '../movement.ts';
import { syncWeapon, rearrangeEquipment } from '../equipment.ts';
import { collectBotIntent } from './bots.ts';
import type { BotIntent } from './bots.ts';
import { consumeInput } from './input.ts';
import { respawn, finishMatch } from './lifecycle.ts';
import { damage, skill, attack } from './combat.ts';
import { solvePhysicsProjectiles } from './physics-projectiles.ts';
import { interact, advanceCharging } from './interactions.ts';
import { automaticPickups, dropEquipment, effect } from './loot.ts';
import { stepTraps } from '../traps.ts';
import { DISCOVERY_INTERVAL, discover } from '../discovery.ts';
import { recordRewind } from './rewind.ts';
import { buildPhysicsGeometry, physicsGate } from './physics-geometry.ts';
import { attachPhysics, physicsRuntime, PHYSICS_VERSION } from './physics-runtime.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game, GameMap, MatchContent, Player, Vec2 } from '../types.ts';

const timers = ['cooldown', 'attackCd', 'railCd', 'cloak', 'revealed', 'boost', 'stun'] as const;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const actorId = (p: Player) => `actor:${p.id}`;
const ordered = (s: Game) => [...s.players].sort((a, b) => compare(a.id, b.id));

/** Explicit opt-in. Legacy createGame stays synchronous and never initializes WASM. */
export async function createPhysicsGame(seed = 4217, map?: GameMap, content?: MatchContent): Promise<Game> {
  const s = createGame(seed, map, content);
  if (s.players.length > 27) throw new RangeError('physics actor capacity is 27');
  const { createPhysicsWorld } = await import('../physics/world.ts');
  const world = await createPhysicsWorld();
  const runtime: PhysicsRuntime = { world, actors: new Set(), gates: new Map(), synchronize: () => synchronize(s, runtime), pendingSpawns: [], pendingImpulses: [], pendingAttachments: [] };
  try {
    const geometry = buildPhysicsGeometry(s.map).sort((a, b) => compare(a.id, b.id));
    for (let i = 0; i < geometry.length; i++) {
      world.queueAddBody(geometry[i]!);
      if (i % 512 === 511) world.commitMutations();
    }
    world.commitMutations();
    // Static authoring is pinned until P8 introduces a shared geometry-revision transaction.
    for (const obstacle of s.map.obstacles) {
      if (obstacle.points) { obstacle.points.forEach(Object.freeze); Object.freeze(obstacle.points); }
      Object.freeze(obstacle);
    }
    Object.freeze(s.map.obstacles);
    if (s.map.playableArea) {
      for (const row of s.map.playableArea.rows) { row.runs.forEach(Object.freeze); Object.freeze(row.runs); Object.freeze(row); }
      Object.freeze(s.map.playableArea.rows); Object.freeze(s.map.playableArea);
    }
    for (const gate of s.map.gates) for (const key of ['id', 'x', 'y', 'w', 'h', 'kind'] as const) Object.defineProperty(gate, key, { writable: false, configurable: false });
    Object.freeze(s.map.gates);
    for (const key of ['width', 'height', 'obstacles', 'playableArea', 'gates'] as const) Object.defineProperty(s.map, key, { writable: false, configurable: false });
    attachPhysics(s, runtime);
    Object.defineProperty(s, 'version', { value: PHYSICS_VERSION, enumerable: true, writable: false });
    synchronize(s, runtime);
    return s;
  } catch (error) { world.dispose(); throw error; }
}

/** Bounded placement is explicit; failing admission never spawns an overlapping body. */
function placement(s: Game, p: Player, admitted: Player[]): Vec2 | null {
  const radius = bodyRadius(p);
  const free = (x: number, y: number) => canOccupy(s.map, x, y, radius) && admitted.every(q => Math.hypot(x - q.x, y - q.y) >= radius + bodyRadius(q));
  if (free(p.x, p.y)) return { x: p.x, y: p.y };
  for (let ring = 1; ring <= 24; ring++) {
    for (let i = 0; i < 32; i++) {
      const angle = i * Math.PI / 16, x = p.x + Math.cos(angle) * ring * 4, y = p.y + Math.sin(angle) * ring * 4;
      if (free(x, y)) return { x, y };
    }
  }
  return null;
}

function synchronize(s: Game, r: PhysicsRuntime): void {
  const active = ordered(s).filter(p => p.status === 'active');
  const wanted = new Set(active.map(actorId));
  for (const id of [...r.actors].sort(compare)) if (!wanted.has(id)) { r.world.queueRemoveBody(id); r.actors.delete(id); }
  r.world.commitMutations();
  const admitted: Player[] = [];
  for (const p of active) {
    const id = actorId(p), current = r.world.getTransform(id);
    if (current && Math.hypot(current.x - p.x, current.y - p.y) < 1e-6) { admitted.push(p); continue; }
    const at = placement(s, p, [...admitted, ...active.filter(q => q !== p && r.actors.has(actorId(q)))]);
    if (!at) {
      if (current) { p.x = current.x; p.y = current.y; admitted.push(p); continue; }
      // Gladiator respawns retry at a future boundary. Initial invalid contestant placement is refused.
      if (p.role === 'gladiator' && s.tick > 0) { p.status = 'respawning'; p.respawnAt = s.tick + 1; continue; }
      throw new Error(`no legal physics placement for ${p.id}`);
    }
    p.x = at.x; p.y = at.y;
    if (current) r.world.setTransform(id, { ...at, angle: 0 });
    else { r.world.queueAddBody({ id, kind: 'actor', shape: { kind: 'circle', radius: bodyRadius(p) }, ...at, mass: 1, friction: 0, restitution: 0 }); r.actors.add(id); r.world.commitMutations(); }
    admitted.push(p);
  }
  for (const gate of [...s.map.gates].sort((a, b) => compare(a.id, b.id))) {
    if (r.gates.get(gate.id) === gate.open) continue;
    if (r.gates.has(gate.id) && !r.gates.get(gate.id)) r.world.queueRemoveBody(`gate:${gate.id}`);
    if (!gate.open) r.world.queueAddBody(physicsGate(gate));
    r.gates.set(gate.id, gate.open);
    r.world.commitMutations();
  }
}

/** Match seat/teleport boundaries reconcile game IDs before the first recorded frame. */
export function synchronizePhysics(s: Game): void { physicsRuntime(s)?.synchronize(); }

/** The separately versioned seven-phase coordinator; never calls legacy movePlayer. */
export function stepPhysics(s: Game): void {
  const r = physicsRuntime(s);
  if (!r) throw new Error('physics world missing or disposed');
  if (s.phase !== 'live') return;
  // 1: all timers and previous-boundary lifecycle, before anyone decides.
  s.tick++;
  s.hazardX = Math.round(-80 + Math.max(0, s.tick - s.content.hazardGraceTicks) / (s.content.durationTicks - s.content.hazardGraceTicks) * (s.map.width + 100));
  s.effects = s.effects.filter(e => --e.life > 0);
  for (const p of s.players) {
    p.movedThisTick = 0; respawn(s, p);
    if (p.status === 'active') for (const key of timers) p[key] = Math.max(0, p[key] - 1);
  }
  synchronize(s, r);
  s.projectiles.push(...r.pendingSpawns.splice(0));
  for (const impulse of r.pendingImpulses.splice(0)) if (r.actors.has(impulse.id) && r.world.getGeneration(impulse.id) === impulse.generation) r.world.queueImpulse(impulse.id, impulse.value);
  for (const attachment of r.pendingAttachments.splice(0).sort((a, b) => compare(a.id, b.id))) {
    const a = r.world.getTransform(attachment.a), b = r.world.getTransform(attachment.b);
    if (a && b && r.actors.has(attachment.a) && r.actors.has(attachment.b)
      && r.world.getGeneration(attachment.a) === attachment.generationA && r.world.getGeneration(attachment.b) === attachment.generationB
      && Math.hypot(a.x - b.x, a.y - b.y) <= attachment.maxDistance && reachClear(s.map, a, b)) r.world.queueAddConstraint(attachment);
  }
  r.world.commitMutations();
  // 2: roster-order collection from the same pre-movement world.
  const intents = new Map<Player, BotIntent>();
  for (const p of s.players) if (p.status === 'active') intents.set(p, p.bot ? collectBotIntent(s, p) : { input: consumeInput(p, s.tick) });
  // 3: inventory then utilities/projectile admission, without damage callbacks during solve.
  for (const p of ordered(s)) {
    const intent = intents.get(p); if (!intent) continue;
    const input = intent.input;
    p.heading = input.aim || 0;
    if (p.inventory && input.slot !== undefined) { p.selectedSlot = input.slot; syncWeapon(p, s.content.weapons); }
    if (input.moveSlot) rearrangeEquipment(p, input.moveSlot.from, input.moveSlot.to, s.content.weapons);
    if (intent.utilitySlot !== undefined && p.selectedSlot === intent.utilitySlot) attack(s, p);
    const discard = intent.discardSlot ?? (input.drop ? p.selectedSlot : undefined);
    if (discard !== undefined && p.inventory?.[discard]) { dropEquipment(s, p, p.inventory[discard]!); p.inventory[discard] = null; p.charging = null; syncWeapon(p, s.content.weapons); }
    if (input.skill && p.kit !== 'warden') skill(s, p);
    if (input.attack && p.role === 'contestant') attack(s, p);
    let speed = p.role === 'contestant' ? 180 : 160;
    if (p.boost) speed *= p.role === 'contestant' ? 1.45 : 1.5;
    if (p.stun) speed *= 0.35;
    if (input.sneak && p.role === 'contestant') speed *= 0.55;
    const x = input.x ?? 0, y = input.y ?? 0, length = Math.max(1, Math.hypot(x, y));
    r.world.setMotor(actorId(p), { x: x / length * speed, y: y / length * speed, accel: 3600 });
  }
  // 4: all bodies together. Query projectiles use these actual substep paths.
  const result = r.world.step();
  for (const p of s.players) if (p.status === 'active') {
    const at = r.world.getTransform(actorId(p));
    if (at) { p.x = at.x; p.y = at.y; p.movedThisTick = result.distance[actorId(p)] ?? 0; }
  }
  // Events are facts only; gameplay has no contact damage profile in P1.
  r.world.drainContacts();
  // 5: physical TOI first, then finalized-pose abilities/melee by stable caster ID.
  solvePhysicsProjectiles(s, result.paths);
  for (const p of ordered(s)) {
    const input = intents.get(p)?.input;
    if (p.status !== 'active' || !input) continue;
    if (input.skill && p.kit === 'warden') skill(s, p);
    if (input.attack && p.role === 'gladiator') attack(s, p);
  }
  // 6: interactions/pickups, environment, traps; trap spawns wait for next tick.
  for (const p of ordered(s)) {
    const input = intents.get(p)?.input;
    if (p.status !== 'active' || !input) continue;
    if (input.interact) interact(s, p);
    if (p.status !== 'active') continue;
    // Ignore contact recovery jitter within the reviewed resting-contact tolerance.
    advanceCharging(s, p, (p.movedThisTick ?? 0) > 0.05 ? { x: 1 } : {});
    automaticPickups(s, p, input);
  }
  for (const p of ordered(s)) if (p.status === 'active') {
    if (p.x < s.hazardX && s.tick % 5 === 0) damage(s, p, 9, null);
    if (s.tick % 12 === 0 && s.map.hazards.some(h => p.x > h.x && p.x < h.x + h.w && p.y > h.y && p.y < h.y + h.h)) damage(s, p, 5, null);
  }
  const admittedProjectiles = s.projectiles.length;
  stepTraps(s, damage, effect);
  r.pendingSpawns.push(...s.projectiles.splice(admittedProjectiles));
  if (r.pendingSpawns.length > 128) throw new RangeError('pending projectile capacity');
  // 7: next-boundary body state, discovery, terminal result, rewind and capture readiness.
  synchronize(s, r);
  if (s.content.discovery) for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i]!;
    if (p.role === 'contestant' && p.discovery && p.status === 'active' && (s.tick + i) % DISCOVERY_INTERVAL === 0) discover(p.discovery, s.map, p, undefined, p.bot);
  }
  finishMatch(s); synchronize(s, r); recordRewind(s);
}
