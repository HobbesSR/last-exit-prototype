import { circle, polygon } from '../shape.ts';
import { actorHitRadius, closedGateShapes, firstContact, impact, staticShapes } from './swept.ts';
import { physicsRuntime } from './physics-runtime.ts';
import type { HookState } from '../physics/types.ts';
import type { Game, Player, Vec2 } from '../types.ts';

const HZ = 20;
const STEPS = 4;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const actor = (id: string) => `actor:${id}`;
const length = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// The tip and tether are physical: unlike shots, see-through obstacles and solid props block them.
function geometry(s: Game) {
  const props = physicsRuntime(s)?.world.snapshot({ includeStatic: false }).bodies
    .filter(body => body.spec.kind === 'prop' && body.spec.collisionProfile !== 'loot') ?? [];
  const propShapes = props.map(({ spec, transform }) => {
    if (spec.shape.kind === 'circle') return circle(transform.x, transform.y, spec.shape.radius);
    const vertices = spec.shape.kind === 'box'
      ? [{ x: -spec.shape.hx, y: -spec.shape.hy }, { x: spec.shape.hx, y: -spec.shape.hy },
        { x: spec.shape.hx, y: spec.shape.hy }, { x: -spec.shape.hx, y: spec.shape.hy }]
      : spec.shape.vertices;
    const c = Math.cos(transform.angle), sin = Math.sin(transform.angle);
    return polygon(transform.x, transform.y, vertices.map(point =>
      ({ x: point.x * c - point.y * sin, y: point.x * sin + point.y * c })));
  });
  return [...staticShapes(s.map, false), ...closedGateShapes(s.map.gates), ...propShapes];
}

/** A blocked prefix wins a simultaneous actor contact. The experimental tip/tether has zero radius. */
function blockedAt(s: Game, a: Vec2, b: Vec2): number { return firstContact(a, b, geometry(s), 0); }

function remove(s: Game, hook: HookState): void {
  const r = physicsRuntime(s);
  if (r?.world.hasConstraint(hook.id)) r.world.queueRemoveConstraint(hook.id);
  if (r) r.hooks = r.hooks.filter(entry => entry !== hook);
}

function endpoints(s: Game, hook: HookState): { caster: Player; target: Player; distance: number } | null {
  const r = physicsRuntime(s), tuning = s.content.hook;
  if (!r || !tuning || !hook.target || hook.generationB === undefined) return null;
  const caster = s.players.find(p => p.id === hook.caster);
  const target = s.players.find(p => p.id === hook.target);
  if (!caster || !target || caster.status !== 'active' || target.status !== 'active' ||
    caster.kit !== 'hook' || caster.role === target.role ||
    r.world.getGeneration(actor(caster.id)) !== hook.generationA ||
    r.world.getGeneration(actor(target.id)) !== hook.generationB) return null;
  const a = r.world.getTransform(actor(caster.id)), b = r.world.getTransform(actor(target.id));
  if (!a || !b) return null;
  const distance = length(a, b);
  if (distance > (hook.phase === 'pending' ? tuning.range : tuning.breakDistance) || blockedAt(s, a, b) < Infinity) return null;
  return { caster, target, distance };
}

/** Skill presses cancel any active flight/tether; only a fresh launch spends cooldown. */
export function hookSkill(s: Game, p: Player): void {
  const r = physicsRuntime(s), tuning = s.content.hook;
  if (!r || !tuning || p.kit !== 'hook' || p.role !== 'gladiator' || p.status !== 'active') return;
  const active = r.hooks.find(hook => hook.caster === p.id);
  if (active) { remove(s, active); r.world.commitMutations(); return; }
  if (p.cooldown > 0) return;
  const activeJoints = r.hooks.filter(hook => r.world.hasConstraint(hook.id)).length;
  if (r.world.counts().constraints - activeJoints + r.hooks.length >= 8) return;
  const generationA = r.world.getGeneration(actor(p.id));
  if (generationA === undefined) return;
  p.cooldown = tuning.cooldownTicks;
  const dx = Math.cos(p.heading), dy = Math.sin(p.heading);
  r.hooks.push({ id: `hook:${p.id}`, caster: p.id, x: p.x, y: p.y, dx, dy,
    travelled: 0, startedTick: s.tick, phase: 'flying', generationA });
  r.hooks.sort((a, b) => compare(a.id, b.id));
}

/** Phase 1: attach a prior tick's hit, then shorten/revalidate every retained tether. */
export function prepareHooks(s: Game): void {
  const r = physicsRuntime(s), tuning = s.content.hook;
  if (!r || !tuning) return;
  for (const hook of [...r.hooks]) {
    if (hook.phase === 'flying') {
      if (s.tick - hook.startedTick >= tuning.durationTicks ||
        r.world.getGeneration(actor(hook.caster)) !== hook.generationA ||
        s.players.find(p => p.id === hook.caster)?.status !== 'active' ||
        s.players.find(p => p.id === hook.caster)?.kit !== 'hook') remove(s, hook);
      continue;
    }
    const pair = endpoints(s, hook);
    if (!pair || s.tick - hook.startedTick >= tuning.durationTicks || pair.distance <= tuning.standoff) {
      remove(s, hook); continue;
    }
    if (hook.phase === 'pending') {
      if (hook.hitTick === undefined || hook.hitTick >= s.tick) continue;
      hook.phase = 'pulling';
      hook.desiredLength = pair.distance;
    } else if (!r.world.hasConstraint(hook.id)) { remove(s, hook); continue; }
    // A target exactly at standoff would asymptotically approach it under damping.
    const desired = Math.max(tuning.targetDistance, hook.desiredLength! - tuning.pullSpeed / HZ);
    hook.desiredLength = desired;
    if (r.world.hasConstraint(hook.id)) {
      r.world.queueRemoveConstraint(hook.id);
      r.world.commitMutations();
    }
    if (r.world.counts().constraints >= 8) { remove(s, hook); continue; }
    r.world.queueAddConstraint({ id: hook.id, kind: 'rope', a: actor(pair.caster.id), b: actor(pair.target.id),
      maxDistance: desired, stiffness: tuning.stiffness, damping: tuning.damping,
      maxForce: tuning.maxForce, breakDistance: tuning.breakDistance });
    r.world.commitMutations();
  }
  r.world.commitMutations();
}

/** Phase 5: server-authoritative tip sweep against moving actors and current geometry. */
export function finishHooks(s: Game, paths: Record<string, Vec2[]>): void {
  const r = physicsRuntime(s), tuning = s.content.hook;
  if (!r || !tuning) return;
  for (const hook of [...r.hooks]) {
    if (hook.phase !== 'flying') continue;
    const caster = s.players.find(p => p.id === hook.caster);
    if (!caster || caster.status !== 'active' || caster.kit !== 'hook' ||
      r.world.getGeneration(actor(caster.id)) !== hook.generationA ||
      s.tick - hook.startedTick >= tuning.durationTicks) { remove(s, hook); continue; }
    const distance = Math.min(tuning.speed / HZ, tuning.range - hook.travelled);
    if (distance <= 0) { remove(s, hook); continue; }
    const a = { x: hook.x, y: hook.y };
    const b = { x: a.x + hook.dx * distance, y: a.y + hook.dy * distance };
    const wall = blockedAt(s, a, b);
    let first: { target: Player; toi: number } | undefined;
    for (const target of [...s.players].sort((a, b) => compare(a.id, b.id))) {
      if (target.id === caster.id || target.status !== 'active') continue;
      const path = paths[actor(target.id)] ?? Array.from({ length: STEPS + 1 }, () => ({ x: target.x, y: target.y }));
      for (let k = 0; k < STEPS; k++) {
        const t = impact(lerp(a, b, k / STEPS), lerp(a, b, (k + 1) / STEPS),
          path[k]!, path[k + 1]!, actorHitRadius(target.role));
        if (t === null) continue;
        const toi = (k + t) / STEPS;
        if (toi < wall && (!first || toi < first.toi || toi === first.toi && compare(target.id, first.target.id) < 0))
          first = { target, toi };
        break;
      }
    }
    if (first) {
      if (first.target.role === caster.role) { remove(s, hook); continue; }
      hook.x = a.x + (b.x - a.x) * first.toi;
      hook.y = a.y + (b.y - a.y) * first.toi;
      hook.travelled += distance * first.toi;
      hook.target = first.target.id;
      const generationB = r.world.getGeneration(actor(first.target.id));
      if (generationB === undefined) { remove(s, hook); continue; }
      hook.generationB = generationB;
      hook.hitTick = s.tick;
      hook.phase = 'pending';
      if (!endpoints(s, hook)) remove(s, hook);
    } else if (wall < Infinity || hook.travelled + distance >= tuning.range) remove(s, hook);
    else { hook.x = b.x; hook.y = b.y; hook.travelled += distance; }
  }
  r.world.commitMutations();
}

/** Phase 7 and between-tick reconciliation after body/gate lifecycle changes. */
export function reconcileHooks(s: Game): void {
  const r = physicsRuntime(s);
  if (!r || !s.content.hook) return;
  for (const hook of [...r.hooks]) {
    if (hook.phase === 'flying') {
      if (r.world.getGeneration(actor(hook.caster)) !== hook.generationA ||
        s.players.find(p => p.id === hook.caster)?.status !== 'active' ||
        s.players.find(p => p.id === hook.caster)?.kit !== 'hook') remove(s, hook);
    } else if (!endpoints(s, hook) || hook.phase === 'pulling' && !r.world.hasConstraint(hook.id)) remove(s, hook);
  }
  r.world.commitMutations();
}
