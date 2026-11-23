//! Wall exposure and traps read S0 and the solved paths (27.2 R5, R6 and R10).

use crate::math::{atan2, cos, hypot, js_round, sin};
use crate::swept::Grid;

use super::combat::{extend, hit};
use super::*;

const WALL_INTERVAL: Tick = 5;
const WALL_DAMAGE: f64 = 9.0;
const AREA_INTERVAL: Tick = 12;
const AREA_DAMAGE: f64 = 5.0;
const MINE_MOVEMENT: f64 = 0.5;
const SPIDER_REACHED: f64 = 20.0;
const SPIDER_RADIUS: f64 = 15.0;
pub(super) const TARGET_CONTEST: u64 = 0x7472_6170_0000_0000;

pub(super) struct Wall {
    pub map_width: f64,
    pub grace_ticks: Tick,
}

pub(super) struct HazardMap {
    areas: Vec<[f64; 4]>,
    grid: Grid,
    wall: Option<Wall>,
    duration: Tick,
}

impl HazardMap {
    pub(super) fn new(areas: Vec<[f64; 4]>, wall: Option<Wall>, duration: Tick) -> Self {
        let grid = Grid::for_bounds(areas.iter().copied());
        Self {
            areas,
            grid,
            wall,
            duration,
        }
    }

    pub(super) fn wall_at(&self, tick: Tick) -> Option<f64> {
        let wall = self.wall.as_ref()?;
        if tick <= wall.grace_ticks {
            return Some(-80.0);
        }
        let elapsed = f64::from(tick - wall.grace_ticks);
        let running = f64::from(self.duration - wall.grace_ticks);
        Some(js_round(
            -80.0 + elapsed / running * (wall.map_width + 100.0),
        ))
    }

    fn touches_area(&self, [x, y]: Point) -> bool {
        self.grid.at(x, y).into_iter().any(|index| {
            let [left, top, w, h] = self.areas[index as usize];
            x > left && x < left + w && y > top && y < top + h
        })
    }
}

pub struct MineTuning {
    pub trigger: f64,
    pub blast: f64,
    pub damage: f64,
    pub world_impulse: f64,
    pub actor_impulse_limit: f64,
}

pub struct TurretTuning {
    pub range: f64,
    pub cooldown: Tick,
    pub speed: f64,
    pub damage: f64,
    pub life: Tick,
}

pub struct FlameTuning {
    pub cycle: Tick,
    pub warn_at: Tick,
    pub fire_at: Tick,
    pub interval: Tick,
    pub range: f64,
    pub cone: f64,
    pub damage: f64,
}

pub struct SpiderTuning {
    pub leash: f64,
    pub acquire: f64,
    pub step: f64,
    pub grapple: f64,
    pub cooldown: Tick,
    pub stun: Tick,
    pub damage: f64,
}

pub struct HazardRules {
    pub mine: MineTuning,
    pub turret: TurretTuning,
    pub flame: FlameTuning,
    pub spider: SpiderTuning,
}

impl Default for HazardRules {
    fn default() -> Self {
        Self {
            mine: MineTuning {
                trigger: 65.0,
                blast: 120.0,
                damage: 45.0,
                world_impulse: 300.0,
                actor_impulse_limit: 600.0,
            },
            turret: TurretTuning {
                range: 650.0,
                cooldown: 35,
                speed: 24.0,
                damage: 12.0,
                life: 30,
            },
            flame: FlameTuning {
                cycle: 160,
                warn_at: 80,
                fire_at: 120,
                interval: 5,
                range: 240.0,
                cone: 0.8,
                damage: 6.0,
            },
            spider: SpiderTuning {
                leash: 360.0,
                acquire: 240.0,
                step: 5.0,
                grapple: 150.0,
                cooldown: 50,
                stun: 30,
                damage: 10.0,
            },
        }
    }
}

impl HazardRules {
    pub(super) fn resolve_into<C, P>(&self, view: &ResolveView<'_>, effects: &mut Effects<C, P>) {
        let start = view.start;
        let wall_due = start.tick.is_multiple_of(WALL_INTERVAL);
        let area_due = start.tick.is_multiple_of(AREA_INTERVAL);
        if !wall_due && !area_due && start.state.traps.is_empty() {
            return;
        }
        let actors: Vec<_> = start
            .state
            .actors
            .iter()
            .filter(|(_, actor)| actor.presence == Presence::Active)
            .filter_map(|(&id, _)| Some((id, view.solved.position(BodyId::Actor(id))?)))
            .collect();
        for &(id, position) in &actors {
            if wall_due && position[0] < start.state.hazard_x {
                hit(effects, Entity::Match, id, WALL_DAMAGE);
            }
            if area_due && start.hazard_map.touches_area(position) {
                hit(effects, Entity::Match, id, AREA_DAMAGE);
            }
        }

        let targets = Targets {
            start,
            solved: view.solved,
            sight: view.current(),
            actors: &actors,
        };
        for (&id, &previous) in &start.state.traps {
            let mut trap = previous;
            trap.kind = match previous.kind {
                TrapKind::Mine { spent: true } => continue,
                TrapKind::Mine { spent: false } => TrapKind::Mine {
                    spent: self.mine.resolve(&targets, id, trap.position, effects),
                },
                TrapKind::Turret { .. } => self.turret.resolve(&targets, id, &mut trap, effects),
                TrapKind::Flame { offset, .. } => {
                    self.flame.resolve(&targets, id, trap, offset, effects)
                }
                TrapKind::Spider { home, target } => self
                    .spider
                    .resolve(&targets, id, &mut trap, home, target, effects),
            };
            if trap != previous {
                effects.lifecycle.push(Lifecycle::UpdateTrap { id, trap });
            }
        }
    }
}

struct Targets<'a, 'b> {
    start: View<'a>,
    solved: &'a Solved,
    sight: Rewound<'a>,
    actors: &'b [(ActorId, Point)],
}

impl Targets<'_, '_> {
    fn nearest(
        &self,
        trap: TrapId,
        origin: Point,
        eligible: impl Fn(Point, f64) -> bool,
    ) -> Option<(ActorId, Point)> {
        let contest = TARGET_CONTEST ^ u64::from(trap.0);
        let rank = |id| {
            (
                contest_score(self.start.seed, self.start.tick, contest, actor_word(id)),
                id,
            )
        };
        self.actors
            .iter()
            .filter_map(|&(id, at)| {
                let range = distance(origin, at);
                (eligible(at, range) && self.sight.line_clear(origin, at))
                    .then_some((id, at, range))
            })
            .min_by(|&(a, _, da), &(b, _, db)| {
                da.total_cmp(&db).then_with(|| rank(a).cmp(&rank(b)))
            })
            .map(|(id, at, _)| (id, at))
    }
}

impl MineTuning {
    fn resolve<C, P>(
        &self,
        targets: &Targets<'_, '_>,
        id: TrapId,
        origin: Point,
        effects: &mut Effects<C, P>,
    ) -> bool {
        let triggered = targets.actors.iter().any(|&(actor, at)| {
            distance(origin, at) < self.trigger
                && targets
                    .solved
                    .distance_travelled(BodyId::Actor(actor))
                    .is_some_and(|length| length > MINE_MOVEMENT)
                && targets.sight.line_clear(origin, at)
        });
        if !triggered {
            return false;
        }
        effects.facts.push(Fact::MineExploded { trap: id });
        for body in targets.solved.bodies() {
            let at = targets.solved.position(body).expect("solved body");
            let range = distance(origin, at);
            if range >= self.blast || !targets.sight.line_clear(origin, at) {
                continue;
            }
            let mut magnitude = self.world_impulse * (1.0 - range / self.blast);
            if let BodyId::Actor(actor) = body {
                if !targets.start.state.active(actor) {
                    continue;
                }
                hit(effects, Entity::Trap(id), actor, self.damage);
                magnitude = magnitude.min(self.actor_impulse_limit);
            }
            if magnitude > 0.0 {
                let [dx, dy] = if range == 0.0 {
                    [1.0, 0.0]
                } else {
                    [(at[0] - origin[0]) / range, (at[1] - origin[1]) / range]
                };
                effects
                    .impulses
                    .push((body, [dx * magnitude, dy * magnitude]));
            }
        }
        true
    }
}

impl TurretTuning {
    fn resolve<C, P>(
        &self,
        targets: &Targets<'_, '_>,
        id: TrapId,
        trap: &mut Trap,
        effects: &mut Effects<C, P>,
    ) -> TrapKind {
        let Some((_, at)) = targets.nearest(id, trap.position, |_, range| range < self.range)
        else {
            return TrapKind::Turret { aiming: false };
        };
        trap.heading = heading(trap.position, at);
        let tick = targets.start.tick;
        if tick >= trap.ready_at {
            trap.ready_at = tick.saturating_add(self.cooldown);
            let active_from = tick.saturating_add(1);
            let source = Entity::Trap(id);
            effects.new_projectiles.insert(
                SpawnKey { source, ordinal: 0 },
                Projectile {
                    source,
                    position: trap.position,
                    velocity: step(trap.heading, self.speed),
                    damage: self.damage,
                    active_from,
                    expires_at: active_from.saturating_add(self.life.saturating_sub(1)),
                },
            );
        }
        TrapKind::Turret { aiming: true }
    }
}

impl FlameTuning {
    fn resolve<C, P>(
        &self,
        targets: &Targets<'_, '_>,
        id: TrapId,
        trap: Trap,
        offset: Tick,
        effects: &mut Effects<C, P>,
    ) -> TrapKind {
        let tick = targets.start.tick;
        let phase = (u64::from(tick) + u64::from(offset)) % u64::from(self.cycle);
        let firing = phase >= u64::from(self.fire_at);
        let warning = phase >= u64::from(self.warn_at) && !firing;
        if firing && tick.is_multiple_of(self.interval) {
            for &(actor, at) in targets.actors {
                if distance(trap.position, at) < self.range
                    && cos(heading(trap.position, at) - trap.heading) > self.cone
                    && targets.sight.line_clear(trap.position, at)
                {
                    hit(effects, Entity::Trap(id), actor, self.damage);
                }
            }
        }
        TrapKind::Flame {
            offset,
            warning,
            firing,
        }
    }
}

impl SpiderTuning {
    fn resolve<C, P>(
        &self,
        targets: &Targets<'_, '_>,
        id: TrapId,
        trap: &mut Trap,
        home: Point,
        target: Option<ActorId>,
        effects: &mut Effects<C, P>,
    ) -> TrapKind {
        let target = target
            .filter(|&actor| targets.start.state.active(actor))
            .and_then(|actor| Some((actor, targets.solved.position(BodyId::Actor(actor))?)))
            .filter(|&(_, at)| distance(home, at) < self.leash)
            .or_else(|| {
                targets.nearest(id, trap.position, |at, _| distance(home, at) < self.acquire)
            });
        let destination = target.map_or(home, |(_, at)| at);
        trap.heading = heading(trap.position, destination);
        if distance(trap.position, destination) > SPIDER_REACHED {
            let [dx, dy] = step(trap.heading, self.step);
            let next = [trap.position[0] + dx, trap.position[1] + dy];
            if distance(home, next) <= self.leash && spider_fits(targets, next) {
                trap.position = next;
            }
        }
        let tick = targets.start.tick;
        if let Some((actor, at)) = target
            && tick >= trap.ready_at
            && distance(trap.position, at) < self.grapple
            && targets.sight.line_clear(trap.position, at)
        {
            trap.ready_at = tick.saturating_add(self.cooldown);
            hit(effects, Entity::Trap(id), actor, self.damage);
            extend(effects, actor, Status::Stun, tick, self.stun);
            effects.facts.push(Fact::SpiderGrappled {
                trap: id,
                target: actor,
                at: at.into(),
            });
        }
        TrapKind::Spider {
            home,
            target: target.map(|(actor, _)| actor),
        }
    }
}

fn spider_fits(targets: &Targets<'_, '_>, at: Point) -> bool {
    let [x, y] = at;
    let radius = SPIDER_RADIUS;
    targets
        .start
        .bounds
        .is_none_or(|[min_x, min_y, max_x, max_y]| {
            x - radius >= min_x && x + radius <= max_x && y - radius >= min_y && y + radius <= max_y
        })
        && !targets
            .start
            .geometry
            .contact_with_gates(false, at, at, radius, &[], |index| {
                targets.sight.gate_open(index)
            })
            .is_finite()
}

fn distance(from: Point, to: Point) -> f64 {
    hypot(to[0] - from[0], to[1] - from[1])
}

fn heading(from: Point, to: Point) -> f64 {
    atan2(to[1] - from[1], to[0] - from[0])
}

fn step(heading: f64, length: f64) -> Point {
    [cos(heading) * length, sin(heading) * length]
}
