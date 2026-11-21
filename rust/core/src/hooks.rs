//! The hook's rules after launch, in the core (#1229, docs/27 "The state flip", step 5d.1): the
//! revalidation of every retained hook at phase 1 (`prepareHooks` in `shared/simulation/hook.ts`), the
//! tip's sweep in phase 5 (`finishHooks`), and the reconciliation that ends every body sync
//! (`reconcileHooks`). Launch and cancel are phase 3's (`phase_three.rs`).
//!
//! The hook records stay in JavaScript (D1). `shared/simulation/hook.ts` packs them, with the players
//! the rules read and, for the tip's sweep, the actors' substep paths, into the world's boundary input.
//! The rules run here over the world (`world.rs`) in the TypeScript's order: generations, poses and
//! constraints are read live, and every queue and commit is made where the TypeScript made it, so the
//! world's facts come out in the same order. The tether and the tip ask the swept query (`swept.rs`)
//! against the solid geometry: the static shapes, the closed gates and the solid props.
//!
//! **What comes back** is the boundary's header, a log and the hooks' final state. The log holds each
//! constraint queued (with what JavaScript needs to build its frozen spec), each commit's facts and
//! each hook removed, in order. Then, per packed hook, its fields as the rules left them. A refusal
//! stops the run where the TypeScript threw: the log holds what was done before it.

use crate::math::{cos, hypot, js_max, js_min, sin};
use crate::physics::{SHAPE_BOX, SHAPE_CIRCLE};
use crate::sight::GateSet;
use crate::swept::{Shape, SweptMap};
use crate::world::{CONSTRAINT_ROW, Key, PropShape, World};

pub const MODE_PREPARE: f64 = 0.0;
pub const MODE_FINISH: f64 = 1.0;
pub const MODE_RECONCILE: f64 = 2.0;

/// The input header: the mode, the tick, the roster's size, the hooks' count, whether paths follow,
/// then the hook tuning (`content.hook`) and `HZ`.
pub const IN_HEADER: usize = 16;
/// Per player, in roster order: `actor key, active, hook kit, gladiator, x, y`.
pub const PLAYER_STRIDE: usize = 6;
/// Per player, when paths follow: `has path`, then the path's five points.
pub const PATH_STRIDE: usize = 11;
/// Per hook, in the runtime's order: `key, caster, id matches the caster, x, y, dx, dy, travelled,
/// started, phase, generation a, target (NaN for none), target key matches, generation b, hit tick,
/// desired length` (NaN for an absent field).
pub const HOOK_STRIDE: usize = 16;

/// The output header: the refusal code (0 when none), the refused key and the constraint's two
/// endpoints (-1 when none), how many commands stay queued, and the output's length in words.
pub const OUT_HEADER: usize = 6;
/// `code, count`, then `count` facts of `world::World::commit`, as the boundary's log has them.
pub const OP_COMMIT: f64 = 2.0;
/// `hook`: the packed hook at that index left the runtime.
pub const OP_REMOVED: f64 = 20.0;
/// `key, a, b, max distance`: a rope queued for the hook whose key it is, with the tuning's
/// stiffness, damping, max force and break distance.
pub const OP_ROPE: f64 = 21.0;
/// Per packed hook after the log: `removed, x, y, travelled, phase, target, generation b, hit tick,
/// desired length`.
pub const STATE_STRIDE: usize = 9;

pub const PHASE_FLYING: f64 = 0.0;
pub const PHASE_PENDING: f64 = 1.0;
pub const PHASE_PULLING: f64 = 2.0;

const STEPS: usize = 4;

struct Tuning {
    range: f64,
    break_distance: f64,
    duration: f64,
    standoff: f64,
    target_distance: f64,
    pull_speed: f64,
    hz: f64,
    stiffness: f64,
    damping: f64,
    max_force: f64,
    speed: f64,
}

#[derive(Clone, Copy)]
struct Player {
    key: Key,
    active: bool,
    hook_kit: bool,
    gladiator: bool,
    x: f64,
    y: f64,
}

#[derive(Clone, Copy)]
struct Hook {
    key: Key,
    caster: f64,
    id_matches: bool,
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    travelled: f64,
    started: f64,
    phase: f64,
    generation_a: f64,
    target: f64,
    target_matches: bool,
    generation_b: f64,
    hit_tick: f64,
    desired: f64,
    removed: bool,
}

/// A refusal: its code, the key it names, and a constraint's endpoints.
type Refusal = (i32, f64, f64, f64);

/// `actorHitRadius` (`swept.ts`).
fn hit_radius(gladiator: bool) -> f64 {
    if gladiator { 26.0 } else { 15.0 }
}

/// `impact` (`swept.ts`): the first relative disk intersection of a moving point and a moving
/// actor, including an initial overlap.
pub fn impact(
    a: [f64; 2],
    b: [f64; 2],
    start: [f64; 2],
    end: [f64; 2],
    radius: f64,
) -> Option<f64> {
    let x = a[0] - start[0];
    let y = a[1] - start[1];
    let dx = b[0] - a[0] - (end[0] - start[0]);
    let dy = b[1] - a[1] - (end[1] - start[1]);
    let c = x * x + y * y - radius * radius;
    if c <= 0.0 {
        return Some(0.0);
    }
    let aa = dx * dx + dy * dy;
    let bb = 2.0 * (x * dx + y * dy);
    let d = bb * bb - 4.0 * aa * c;
    // `!aa`: zero or NaN.
    if aa == 0.0 || aa.is_nan() || d < 0.0 {
        return None;
    }
    let t = (-bb - d.sqrt()) / (2.0 * aa);
    if (0.0..=1.0).contains(&t) {
        Some(t)
    } else {
        None
    }
}

fn lerp(a: [f64; 2], b: [f64; 2], t: f64) -> [f64; 2] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/// `bodyShape` (`shared/physics/presentation-geometry.ts`) of a solid prop at its pose.
fn prop_shape(shape: &PropShape, x: f64, y: f64, angle: f64) -> Shape {
    if shape.shape == SHAPE_CIRCLE {
        return Shape::Circle { x, y, r: shape.a };
    }
    let points: Vec<[f64; 2]> = if shape.shape == SHAPE_BOX {
        let (hx, hy) = (shape.a, shape.b);
        vec![[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]
    } else {
        shape.vertices.as_chunks::<2>().0.to_vec()
    };
    // `transform(polygon(0, 0, points), x, y, angle)`: `!angle` keeps the points.
    if angle == 0.0 || angle.is_nan() {
        return Shape::Polygon {
            x: 0.0 + x,
            y: 0.0 + y,
            points,
        };
    }
    let (c, s) = (cos(angle), sin(angle));
    Shape::Polygon {
        x: 0.0 + x,
        y: 0.0 + y,
        points: points
            .iter()
            .map(|p| [p[0] * c - p[1] * s, p[0] * s + p[1] * c])
            .collect(),
    }
}

/// `solidProps` (`swept.ts`): the world's solid props, in ID order, as query shapes.
fn solid_props(world: &mut World) -> Vec<Shape> {
    world
        .solid_prop_poses()
        .iter()
        .map(|(shape, x, y, angle)| prop_shape(shape, *x, *y, *angle))
        .collect()
}

/// `solidContact` (`swept.ts`): the first contact with the solid geometry, the world's solid props
/// included. The hook's rules ask it through `Run`, which reads the props once per commit; this is
/// the parity check's entry (`tests/swept-core.test.js`).
pub fn solid_contact(
    world: &mut World,
    swept: &SweptMap,
    gates: &GateSet,
    a: [f64; 2],
    b: [f64; 2],
    radius: f64,
) -> f64 {
    let props = solid_props(world);
    swept.contact(gates, false, a, b, radius, &props)
}

struct Run<'a> {
    world: &'a mut World,
    swept: &'a SweptMap,
    gates: &'a GateSet,
    tick: f64,
    tuning: Tuning,
    players: Vec<Player>,
    /// The solid props as query shapes, read from the world when first asked after a commit.
    props: Option<Vec<Shape>>,
    log: Vec<f64>,
}

impl Run<'_> {
    fn player(&self, index: f64) -> Option<Player> {
        if index.is_nan() || index < 0.0 {
            return None;
        }
        self.players.get(index as usize).copied()
    }

    /// `blockedAt` (`hook.ts`): `solidContact` with zero radius.
    fn blocked_at(&mut self, a: [f64; 2], b: [f64; 2]) -> f64 {
        if self.props.is_none() {
            self.props = Some(solid_props(self.world));
        }
        let props = self.props.as_deref().expect("read above");
        self.swept.contact(self.gates, false, a, b, 0.0, props)
    }

    /// `commitMutations`: commits when anything is queued, logging the facts.
    fn commit(&mut self) -> Result<(), Refusal> {
        if self.world.queued_count() == 0 {
            return Ok(());
        }
        let code = self.world.commit();
        self.props = None;
        let facts = self.world.output();
        self.log.extend_from_slice(&[OP_COMMIT, f64::from(code)]);
        self.log.extend_from_slice(facts);
        if code < 0 {
            Err((code, -1.0, -1.0, -1.0))
        } else {
            Ok(())
        }
    }

    /// `remove` (`hook.ts`): queues the rope's removal if it is live, and the hook leaves the runtime.
    fn remove(&mut self, hooks: &mut [Hook], i: usize) -> Result<(), Refusal> {
        let key = hooks[i].key;
        if self.world.has_constraint(key) {
            let code = self.world.queue_remove_constraint(key);
            if code < 0 {
                return Err((code, f64::from(key), -1.0, -1.0));
            }
        }
        hooks[i].removed = true;
        self.log.extend_from_slice(&[OP_REMOVED, i as f64]);
        Ok(())
    }

    /// Whether the flying hook's caster still holds it: active, of the hook kit, the hook's ID its own
    /// and its body the one it launched from.
    fn caster_holds(&self, hook: &Hook) -> bool {
        self.player(hook.caster).is_some_and(|c| {
            c.active
                && c.hook_kit
                && hook.id_matches
                && self.world.generation(c.key) == hook.generation_a
        })
    }

    /// `endpoints` (`hook.ts`): the caster, the target and their distance, while the tether holds.
    fn endpoints(&mut self, hook: &Hook) -> Option<f64> {
        if hook.target.is_nan() || hook.generation_b.is_nan() {
            return None;
        }
        let caster = self.player(hook.caster)?;
        let target = self.player(hook.target)?;
        if !caster.active
            || !target.active
            || !caster.hook_kit
            || caster.gladiator == target.gladiator
            || !hook.id_matches
            || !hook.target_matches
            || self.world.generation(caster.key) != hook.generation_a
            || self.world.generation(target.key) != hook.generation_b
        {
            return None;
        }
        let a = self.world.position(caster.key)?;
        let b = self.world.position(target.key)?;
        let distance = hypot(a.0 - b.0, a.1 - b.1);
        let limit = if hook.phase == PHASE_PENDING {
            self.tuning.range
        } else {
            self.tuning.break_distance
        };
        if distance > limit || self.blocked_at([a.0, a.1], [b.0, b.1]) < f64::INFINITY {
            return None;
        }
        Some(distance)
    }

    /// `prepareHooks`: attach a prior tick's hit, then shorten and revalidate every retained tether.
    fn prepare(&mut self, hooks: &mut [Hook]) -> Result<(), Refusal> {
        for i in 0..hooks.len() {
            let hook = hooks[i];
            if hook.phase == PHASE_FLYING {
                if self.tick - hook.started >= self.tuning.duration || !self.caster_holds(&hook) {
                    self.remove(hooks, i)?;
                }
                continue;
            }
            let distance = self.endpoints(&hook);
            let Some(distance) = distance.filter(|&d| {
                !(self.tick - hook.started >= self.tuning.duration || d <= self.tuning.standoff)
            }) else {
                self.remove(hooks, i)?;
                continue;
            };
            if hook.phase == PHASE_PENDING {
                if hook.hit_tick.is_nan() || hook.hit_tick >= self.tick {
                    continue;
                }
                hooks[i].phase = PHASE_PULLING;
                hooks[i].desired = distance;
            } else if !self.world.has_constraint(hook.key) {
                self.remove(hooks, i)?;
                continue;
            }
            // A target exactly at standoff would asymptotically approach it under damping.
            let desired = js_max(
                self.tuning.target_distance,
                hooks[i].desired - self.tuning.pull_speed / self.tuning.hz,
            );
            hooks[i].desired = desired;
            if self.world.has_constraint(hook.key) {
                let code = self.world.queue_remove_constraint(hook.key);
                if code < 0 {
                    return Err((code, f64::from(hook.key), -1.0, -1.0));
                }
                self.commit()?;
            }
            if self.world.constraint_count() >= 8 {
                self.remove(hooks, i)?;
                continue;
            }
            let caster = self.player(hook.caster).expect("endpoints held").key;
            let target = self.player(hook.target).expect("endpoints held").key;
            let t = &self.tuning;
            let mut row = [0.0; CONSTRAINT_ROW];
            row[..10].copy_from_slice(&[
                f64::from(hook.key),
                f64::from(caster),
                f64::from(target),
                1.0,
                desired,
                0.0,
                t.stiffness,
                t.damping,
                t.max_force,
                t.break_distance,
            ]);
            let code = self.world.queue_constraint_row(&row);
            if code < 0 {
                return Err((
                    code,
                    f64::from(hook.key),
                    f64::from(caster),
                    f64::from(target),
                ));
            }
            self.log.extend_from_slice(&[
                OP_ROPE,
                f64::from(hook.key),
                f64::from(caster),
                f64::from(target),
                desired,
            ]);
            self.commit()?;
        }
        self.commit()
    }

    /// `finishHooks`: the tip's sweep against the moving actors and the current solid geometry.
    fn finish(
        &mut self,
        hooks: &mut [Hook],
        paths: &[Option<[[f64; 2]; STEPS + 1]>],
        order: &[usize],
    ) -> Result<(), Refusal> {
        for i in 0..hooks.len() {
            let hook = hooks[i];
            if hook.phase != PHASE_FLYING {
                continue;
            }
            if !self.caster_holds(&hook) || self.tick - hook.started >= self.tuning.duration {
                self.remove(hooks, i)?;
                continue;
            }
            let caster = self.player(hook.caster).expect("held");
            let distance = js_min(
                self.tuning.speed / self.tuning.hz,
                self.tuning.range - hook.travelled,
            );
            if distance <= 0.0 {
                self.remove(hooks, i)?;
                continue;
            }
            let a = [hook.x, hook.y];
            let b = [a[0] + hook.dx * distance, a[1] + hook.dy * distance];
            let wall = self.blocked_at(a, b);
            let mut first: Option<(usize, f64)> = None;
            for &index in order {
                let target = self.players[index];
                if target.key == caster.key || !target.active {
                    continue;
                }
                let path = paths[index].unwrap_or([[target.x, target.y]; STEPS + 1]);
                for k in 0..STEPS {
                    let Some(t) = impact(
                        lerp(a, b, k as f64 / STEPS as f64),
                        lerp(a, b, (k + 1) as f64 / STEPS as f64),
                        path[k],
                        path[k + 1],
                        hit_radius(target.gladiator),
                    ) else {
                        continue;
                    };
                    let toi = (k as f64 + t) / STEPS as f64;
                    // Targets are visited in ID order, so an equal time keeps the earlier ID.
                    if toi < wall && first.is_none_or(|(_, best)| toi < best) {
                        first = Some((index, toi));
                    }
                    break;
                }
            }
            if let Some((index, toi)) = first {
                let target = self.players[index];
                if target.gladiator == caster.gladiator {
                    self.remove(hooks, i)?;
                    continue;
                }
                let h = &mut hooks[i];
                h.x = a[0] + (b[0] - a[0]) * toi;
                h.y = a[1] + (b[1] - a[1]) * toi;
                h.travelled += distance * toi;
                h.target = index as f64;
                h.target_matches = true;
                let generation = self.world.generation(target.key);
                if generation < 0.0 {
                    self.remove(hooks, i)?;
                    continue;
                }
                let h = &mut hooks[i];
                h.generation_b = generation;
                h.hit_tick = self.tick;
                h.phase = PHASE_PENDING;
                let hook = *h;
                if self.endpoints(&hook).is_none() {
                    self.remove(hooks, i)?;
                }
            } else if wall < f64::INFINITY || hook.travelled + distance >= self.tuning.range {
                self.remove(hooks, i)?;
            } else {
                let h = &mut hooks[i];
                h.x = b[0];
                h.y = b[1];
                h.travelled += distance;
            }
        }
        self.commit()
    }

    /// `reconcileHooks`: after the body and gate lifecycle changes of a sync.
    fn reconcile(&mut self, hooks: &mut [Hook]) -> Result<(), Refusal> {
        for i in 0..hooks.len() {
            let hook = hooks[i];
            if hook.phase == PHASE_FLYING {
                if !self.caster_holds(&hook) {
                    self.remove(hooks, i)?;
                }
            } else if self.endpoints(&hook).is_none()
                || hook.phase == PHASE_PULLING && !self.world.has_constraint(hook.key)
            {
                self.remove(hooks, i)?;
            }
        }
        self.commit()
    }
}

/// One hook call over the world's boundary input; the header, log and states go to its boundary
/// output.
pub fn run(world: &mut World, swept: &SweptMap, gates: &GateSet) {
    let input = std::mem::take(&mut world.boundary_input);
    let v = |i: usize| input[i];
    let mode = v(0);
    let player_count = v(2) as usize;
    let hook_count = v(3) as usize;
    let with_paths = v(4) != 0.0;
    let tuning = Tuning {
        range: v(5),
        break_distance: v(6),
        duration: v(7),
        standoff: v(8),
        target_distance: v(9),
        pull_speed: v(10),
        hz: v(11),
        stiffness: v(12),
        damping: v(13),
        max_force: v(14),
        speed: v(15),
    };
    let mut at = IN_HEADER;
    let players: Vec<Player> = (0..player_count)
        .map(|i| {
            let r = &input[at + i * PLAYER_STRIDE..at + (i + 1) * PLAYER_STRIDE];
            Player {
                key: r[0] as Key,
                active: r[1] != 0.0,
                hook_kit: r[2] != 0.0,
                gladiator: r[3] != 0.0,
                x: r[4],
                y: r[5],
            }
        })
        .collect();
    at += player_count * PLAYER_STRIDE;
    let order: Vec<usize> = input[at..at + player_count]
        .iter()
        .map(|&i| i as usize)
        .collect();
    at += player_count;
    let mut paths: Vec<Option<[[f64; 2]; STEPS + 1]>> = vec![None; player_count];
    if with_paths {
        for path in paths.iter_mut() {
            let r = &input[at..at + PATH_STRIDE];
            if r[0] != 0.0 {
                let mut points = [[0.0; 2]; STEPS + 1];
                for (k, point) in points.iter_mut().enumerate() {
                    *point = [r[1 + 2 * k], r[2 + 2 * k]];
                }
                *path = Some(points);
            }
            at += PATH_STRIDE;
        }
    }
    let mut hooks: Vec<Hook> = (0..hook_count)
        .map(|i| {
            let r = &input[at + i * HOOK_STRIDE..at + (i + 1) * HOOK_STRIDE];
            Hook {
                key: r[0] as Key,
                caster: r[1],
                id_matches: r[2] != 0.0,
                x: r[3],
                y: r[4],
                dx: r[5],
                dy: r[6],
                travelled: r[7],
                started: r[8],
                phase: r[9],
                generation_a: r[10],
                target: r[11],
                target_matches: r[12] != 0.0,
                generation_b: r[13],
                hit_tick: r[14],
                desired: r[15],
                removed: false,
            }
        })
        .collect();
    let mut run = Run {
        world,
        swept,
        gates,
        tick: v(1),
        tuning,
        players,
        props: None,
        log: Vec::new(),
    };
    let result = if mode == MODE_PREPARE {
        run.prepare(&mut hooks)
    } else if mode == MODE_FINISH {
        run.finish(&mut hooks, &paths, &order)
    } else {
        run.reconcile(&mut hooks)
    };
    let (code, key, a, b) = result.err().unwrap_or((0, -1.0, -1.0, -1.0));
    let log = std::mem::take(&mut run.log);
    let world = run.world;
    let mut out = std::mem::take(&mut world.boundary_output);
    out.clear();
    out.extend_from_slice(&[f64::from(code), key, a, b, world.queued_count() as f64, 0.0]);
    out.extend_from_slice(&log);
    for h in &hooks {
        out.extend_from_slice(&[
            f64::from(u8::from(h.removed)),
            h.x,
            h.y,
            h.travelled,
            h.phase,
            h.target,
            h.generation_b,
            h.hit_tick,
            h.desired,
        ]);
    }
    out[OUT_HEADER - 1] = out.len() as f64;
    world.boundary_output = out;
    world.boundary_input = input;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn impact_counts_an_initial_overlap_and_misses_a_parallel_pass() {
        assert_eq!(
            impact([0.0, 0.0], [10.0, 0.0], [5.0, 0.0], [5.0, 0.0], 15.0),
            Some(0.0)
        );
        assert_eq!(
            impact([0.0, 0.0], [10.0, 0.0], [0.0, 30.0], [10.0, 30.0], 15.0),
            None
        );
        let t = impact([0.0, 0.0], [100.0, 0.0], [50.0, 0.0], [50.0, 0.0], 10.0).unwrap();
        assert_eq!(t, 0.4);
    }

    #[test]
    fn an_unrotated_box_keeps_its_points() {
        let shape = PropShape {
            shape: SHAPE_BOX,
            a: 2.0,
            b: 3.0,
            vertices: vec![],
        };
        let Shape::Polygon { x, y, points } = prop_shape(&shape, 5.0, 6.0, 0.0) else {
            panic!()
        };
        assert_eq!((x, y), (5.0, 6.0));
        assert_eq!(
            points,
            vec![[-2.0, -3.0], [2.0, -3.0], [2.0, 3.0], [-2.0, 3.0]]
        );
    }
}
