import { playerIndex } from './relations.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { playersStale, uploadPlayers } from './player-store.ts';
import { sightOf } from './sight-runtime.ts';
import { HZ } from './rules.ts';
import { physicsRefusal } from '../physics/world.ts';
import type { HookState } from '../physics/types.ts';
import type { Game, Player, PlayerIdx, Vec2 } from '../types.ts';
import { cos, sin } from '../math.ts';

const STEPS = 4;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const actor = (id: string) => `actor:${id}`;

function remove(s: Game, hook: HookState): void {
  const r = physicsRuntime(s);
  if (r?.world.hasConstraint(hook.id)) r.world.queueRemoveConstraint(hook.id);
  if (r) r.hooks = r.hooks.filter(entry => entry !== hook);
}

/** Skill presses cancel any active flight/tether; only a fresh launch spends cooldown. */
export function hookSkill(s: Game, p: Player): void {
  const r = physicsRuntime(s), tuning = s.content.hook;
  if (!r || p.kit !== 'hook' || p.role !== 'gladiator' || p.status !== 'active') return;
  const casterIdx = playerIndex(s, p);
  const active = r.hooks.find(hook => hook.casterIdx === casterIdx && hook.id === `hook:${p.id}`);
  if (active) { remove(s, active); r.world.commitMutations(); return; }
  if (p.cooldown > 0) return;
  const activeJoints = r.hooks.filter(hook => r.world.hasConstraint(hook.id)).length;
  if (r.world.counts().constraints - activeJoints + r.hooks.length >= 8) return;
  const generationA = r.world.getGeneration(actor(p.id));
  if (generationA === undefined) return;
  p.cooldown = tuning.cooldownTicks;
  const dx = cos(p.heading), dy = sin(p.heading);
  const hook: HookState = { id: `hook:${p.id}`, tetherId: r.identities.newTether(), casterIdx, x: p.x, y: p.y, dx, dy,
    travelled: 0, startedTick: s.tick, phase: 'flying', generationA };
  r.hooks.push(hook);
  r.hooks.sort((a, b) => compare(a.id, b.id));
}

// The hook's rules after launch run in the core (`rust/core/src/hooks.rs`, #1229, docs/27 step 5d.1): the records stay
// here (D1), so each call packs the hooks and, for the tip, the actors' substep paths (the players come from the core's
// store, `player-store.ts`, #1214 stage 6c.3a), and applies
// what comes back: each rope queued (its spec built here, as `queueAddConstraint` built it), each commit's facts, each
// hook removed, then the hooks' fields as the rules left them. With no hook there is nothing to run, only the commit
// each of the three ended with.
const MODE_PREPARE = 0, MODE_FINISH = 1, MODE_RECONCILE = 2;
const OUT_HEADER = 6, OP_COMMIT = 2, OP_REMOVED = 20, OP_ROPE = 21, STATE_STRIDE = 9;
const PHASES = ['flying', 'pending', 'pulling'] as const;

function runHooks(s: Game, mode: number, paths?: Record<string, Vec2[]>): void {
  const r = physicsRuntime(s);
  if (!r) return;
  if (!r.hooks.length) { r.world.commitMutations(); return; }
  const world = r.world, tuning = s.content.hook, hooks = [...r.hooks], players = s.players;
  const data: number[] = [mode, s.tick, players.length, hooks.length, paths ? 1 : 0, tuning.range, tuning.breakDistance,
    tuning.durationTicks, tuning.standoff, tuning.targetDistance, tuning.pullSpeed, HZ, tuning.stiffness, tuning.damping,
    tuning.maxForce, tuning.speed];
  if (paths) for (const p of players) {
    const path = paths[actor(p.id)];
    if (!path) { data.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); continue; }
    data.push(1);
    for (let k = 0; k <= STEPS; k++) data.push(path[k]!.x, path[k]!.y);
  }
  for (const hook of hooks) {
    const caster = players[hook.casterIdx], target = hook.targetIdx === undefined ? undefined : players[hook.targetIdx];
    data.push(world.key(hook.id), hook.casterIdx, caster && hook.id === `hook:${caster.id}` ? 1 : 0, hook.x, hook.y, hook.dx, hook.dy,
      hook.travelled, hook.startedTick, PHASES.indexOf(hook.phase), hook.generationA, hook.targetIdx ?? NaN,
      target && hook.targetActorKey === actor(target.id) ? 1 : 0, hook.generationB ?? NaN, hook.hitTick ?? NaN, hook.desiredLength ?? NaN);
  }
  // Interning and the handles' preparation can grow memory; view the input only after them.
  const { core, world: native } = world.boundaryCall();
  // The players come from the core's store (`player-store.ts`, #1214 stage 6c.3a).
  if (playersStale(r)) uploadPlayers(s, r, core, native);
  const sight = sightOf(s), map = sight.queryHandles(s.map), swept = sight.sweptHandle(s.map);
  if (map.core !== core) throw new Error('the physics world and sight are bound to different cores');
  const pointer = core.physics_boundary_input(native, data.length) >>> 0;
  new Float64Array(core.memory.buffer, pointer, data.length).set(data);
  core.physics_hooks(native, swept, map.gates);
  const outPointer = core.physics_boundary_output(native) >>> 0;
  const out = new Float64Array(core.memory.buffer, outPointer, new Float64Array(core.memory.buffer, outPointer, OUT_HEADER)[5]!).slice();
  const removed = new Set<HookState>(), states = out.length - hooks.length * STATE_STRIDE;
  for (let at = OUT_HEADER; at < states;) {
    const op = out[at]!;
    if (op === OP_COMMIT) { world.adoptCommit(out[at + 1]!, out, at + 2); at += 3 + out[at + 2]! * 2; }
    else if (op === OP_REMOVED) { removed.add(hooks[out[at + 1]!]!); at += 2; }
    else if (op === OP_ROPE) {
      world.adoptQueuedConstraint(out[at + 1]!, { id: world.idOf(out[at + 1]!), kind: 'rope', a: world.idOf(out[at + 2]!),
        b: world.idOf(out[at + 3]!), maxDistance: out[at + 4]!, stiffness: tuning.stiffness, damping: tuning.damping,
        maxForce: tuning.maxForce, breakDistance: tuning.breakDistance });
      at += 5;
    } else throw new Error(`unknown hook fact ${op}`);
  }
  // Fields are written in the order the TypeScript rules first wrote them, so a hook's keys keep their order.
  hooks.forEach((hook, i) => {
    if (removed.has(hook)) return;
    const at = states + i * STATE_STRIDE, put = <K extends keyof HookState>(key: K, value: number, as: HookState[K]): void => {
      if (Number.isNaN(value) && hook[key] === undefined || Object.is(hook[key], as)) return;
      hook[key] = as;
    };
    put('x', out[at + 1]!, out[at + 1]!); put('y', out[at + 2]!, out[at + 2]!); put('travelled', out[at + 3]!, out[at + 3]!);
    const target = out[at + 5]!;
    if (!Number.isNaN(target) && (hook.targetIdx !== target || hook.targetActorKey !== actor(players[target]!.id))) {
      hook.targetIdx = target as PlayerIdx; hook.targetActorKey = actor(players[target]!.id);
    }
    put('generationB', out[at + 6]!, out[at + 6]!); put('hitTick', out[at + 7]!, out[at + 7]!);
    put('phase', out[at + 4]!, PHASES[out[at + 4]!]!); put('desiredLength', out[at + 8]!, out[at + 8]!);
  });
  if (removed.size) r.hooks = r.hooks.filter(hook => !removed.has(hook));
  world.adoptQueue(out[4]!);
  if (out[0]! < 0) throw physicsRefusal(out[0]!, ...[out[1]!, out[2]!, out[3]!].filter(key => key >= 0).map(key => world.idOf(key)));
}

/** Phase 1: attach a prior tick's hit, then shorten/revalidate every retained tether. */
export function prepareHooks(s: Game): void { runHooks(s, MODE_PREPARE); }

/** Phase 5: server-authoritative tip sweep against moving actors and current geometry. */
export function finishHooks(s: Game, paths: Record<string, Vec2[]>): void { runHooks(s, MODE_FINISH, paths); }

/** Phase 7 and between-tick reconciliation after body/gate lifecycle changes. */
export function reconcileHooks(s: Game): void { runHooks(s, MODE_RECONCILE); }
