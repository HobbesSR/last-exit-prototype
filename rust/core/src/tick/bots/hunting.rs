//! Hunter sweep, front evidence, charger leads and transit selection.
use super::{
    Actor, ActorId, ActorKind, Bot, Context, EquipmentKind, Hunting, ItemId, Point, Presence,
    StationId, StationKind, Status, Tick, active_status, distance,
};
use std::collections::{BTreeMap, BTreeSet};

const AHEAD: f64 = 600.0;
const ARRIVE: f64 = 400.0;
const REVISIT: Tick = 1800;
const STALL: Tick = 200;
const GOALKEEP_RADIUS: f64 = 2400.0;

#[derive(Default)]
pub(super) struct Front {
    further_right: bool,
    checked: Option<Tick>,
    charged: BTreeSet<ItemId>,
    charger: Option<(Point, Tick)>,
}
#[derive(Default)]
pub(super) struct Sweep {
    swept: BTreeMap<usize, Tick>,
    region: Option<usize>,
    target: Option<Point>,
    pub targeted: bool,
    moved: Point,
    progressed: Tick,
    charger_checked: Option<Tick>,
}
impl Sweep {
    pub(super) fn give_up(&mut self, tick: Tick) {
        if let Some(region) = self.region.take() {
            self.swept.insert(region, tick);
        }
        self.target = None;
    }
    fn set(&mut self, region: Option<usize>, target: Point, pos: Point, tick: Tick) -> Point {
        self.region = region;
        self.target = Some(target);
        self.moved = pos;
        self.progressed = tick;
        target
    }
}
fn front_x(ctx: &Context<'_>) -> f64 {
    ctx.exit()[0].min((ctx.entry_x + ctx.view.tick as f64 * 4.0).max(ctx.wall() + AHEAD))
}
impl Front {
    pub(super) fn update(&mut self, ctx: &Context<'_>) {
        if ctx.settings.hunting != Hunting::Front || self.checked == Some(ctx.view.tick) {
            return;
        }
        let tick = ctx.view.tick;
        self.checked = Some(tick);
        if !self.further_right {
            let front = front_x(ctx);
            let threshold = (ctx.exit()[0] - ARRIVE).min(front + 1600.0);
            let gladiators: Vec<_> = ctx
                .settings
                .roster
                .iter()
                .map(|x| x.0)
                .filter(|id| id.kind == ActorKind::Gladiator && ctx.view.state.active(*id))
                .collect();
            self.further_right = front >= ctx.exit()[0] - ARRIVE
                || ctx.view.state.extraction.is_some_and(|e| e.slots < 3)
                || gladiators.iter().any(|&g| {
                    ctx.cues
                        .heard(g, tick)
                        .iter()
                        .any(|cue| cue.at[0] > threshold)
                })
                || ctx.settings.roster.iter().map(|x| x.0).any(|id| {
                    let Some(actor) = ctx.view.state.actors.get(&id) else {
                        return false;
                    };
                    id.kind == ActorKind::Contestant
                        && actor.presence == Presence::Active
                        && ctx.point(id).is_some_and(|p| p[0] > threshold)
                        && (active_status(actor, Status::Reveal, tick)
                            || gladiators.iter().any(|&g| ctx.visible(g, id)))
                });
        }
        for &(id, ..) in &ctx.settings.roster {
            if id.kind != ActorKind::Contestant {
                continue;
            }
            let Some(actor) = ctx.view.state.actors.get(&id) else {
                continue;
            };
            let cell = actor
                .inventory
                .slots
                .iter()
                .flatten()
                .find(|item| matches!(item.equipment.kind, EquipmentKind::Cell { .. }));
            let Some(cell) = cell else {
                continue;
            };
            if !matches!(cell.equipment.kind, EquipmentKind::Cell { charge } if charge >= ctx.rules.interactions.charge_ticks)
                || !self.charged.insert(cell.id)
            {
                continue;
            }
            let Some(pos) = ctx.point(id) else {
                continue;
            };
            let nearest = ctx
                .view
                .state
                .stations
                .values()
                .filter(|s| s.kind == StationKind::Charging && s.position[0] > ctx.wall() + AHEAD)
                .min_by(|a, b| distance(pos, a.position).total_cmp(&distance(pos, b.position)));
            if let Some(station) = nearest {
                self.charger = Some((station.position, tick));
            }
        }
    }
}
fn repel(peers: &BTreeMap<ActorId, Bot>, ctx: &Context<'_>, id: ActorId, centre: Point) -> f64 {
    let mut penalty = 0.0;
    for &(other, ..) in &ctx.settings.roster {
        if other == id || other.kind != ActorKind::Gladiator {
            continue;
        }
        let Some(actor) = ctx.view.state.actors.get(&other) else {
            continue;
        };
        if actor.presence == Presence::Eliminated
            || peers.get(&other).is_some_and(|p| p.sweeping.targeted)
        {
            continue;
        }
        for point in [
            ctx.point(other),
            peers.get(&other).and_then(|p| p.sweeping.target),
        ]
        .into_iter()
        .flatten()
        {
            let d = distance(point, centre);
            if d < 3600.0 {
                penalty += (1.0 - d / 3600.0) * 2400.0;
            }
        }
    }
    penalty
}

pub(super) fn target(
    ctx: &Context<'_>,
    front: &mut Front,
    id: ActorId,
    pos: Point,
    sweep: &mut Sweep,
    peers: &BTreeMap<ActorId, Bot>,
    mut stand: impl FnMut(Point) -> Point,
) -> Option<Point> {
    let tick = ctx.view.tick;
    let front_mode = ctx.settings.hunting == Hunting::Front;
    let goalkeep = front_mode && front.further_right;
    let investigating = front.charger.filter(|(p, t)| {
        front_mode
            && tick.saturating_sub(*t) <= 1200
            && p[0] > ctx.wall() + AHEAD
            && sweep.charger_checked.is_none_or(|checked| checked < *t)
    });
    let graph = ctx.navigation.and_then(|nav| nav.graph());
    let Some(graph) = graph else {
        return if goalkeep {
            Some(stand(ctx.exit()))
        } else {
            investigating.map(|(p, _)| stand(p))
        };
    };
    if let Some(target) = sweep.target {
        let invalid = front_mode
            && (target[0] < ctx.wall() + AHEAD
                || (goalkeep
                    && investigating.is_none()
                    && distance(ctx.exit(), target) > GOALKEEP_RADIUS)
                || investigating.is_some_and(|(p, _)| distance(p, target) > ARRIVE)
                || (!goalkeep && investigating.is_none() && target[0] < front_x(ctx) - 2400.0));
        if invalid {
            sweep.give_up(tick);
        } else {
            if distance(pos, sweep.moved) > 40.0 {
                sweep.moved = pos;
                sweep.progressed = tick;
            }
            if distance(pos, target) < ARRIVE || tick.saturating_sub(sweep.progressed) > STALL {
                if investigating.is_some_and(|(p, _)| distance(pos, p) < ARRIVE) {
                    sweep.charger_checked = Some(tick);
                }
                sweep.give_up(tick);
            } else {
                return Some(target);
            }
        }
    }
    if let Some((station, _)) = investigating {
        if distance(pos, station) < ARRIVE {
            sweep.charger_checked = Some(tick);
        } else {
            sweep.targeted = true;
            return Some(sweep.set(None, stand(station), pos, tick));
        }
    }
    let mut regions = Vec::new();
    let mut index = 0;
    while let Some(region) = graph.region(index) {
        let [x, y, w, h] = region.bounds;
        regions.push([x + w / 2.0, y + h / 2.0]);
        index += 1;
    }
    let taken: BTreeSet<_> = ctx
        .settings
        .roster
        .iter()
        .map(|x| x.0)
        .filter(|other| {
            *other != id
                && other.kind == ActorKind::Gladiator
                && ctx
                    .view
                    .state
                    .actors
                    .get(other)
                    .is_some_and(|a| a.presence != Presence::Eliminated)
                && (!front_mode || !peers.get(other).is_some_and(|p| p.sweeping.targeted))
        })
        .filter_map(|other| peers.get(&other).and_then(|p| p.sweeping.region))
        .collect();
    let eligible = |i: usize, centre: Point, ignore_revisit: bool| {
        centre[0] >= ctx.wall() + AHEAD
            && !taken.contains(&i)
            && (ignore_revisit
                || sweep
                    .swept
                    .get(&i)
                    .is_none_or(|last| tick.saturating_sub(*last) >= REVISIT))
    };
    if !front_mode {
        let best = regions
            .iter()
            .copied()
            .enumerate()
            .filter(|&(i, p)| eligible(i, p, false))
            .min_by(|a, b| {
                (distance(pos, a.1) + (a.1[0] - ctx.wall()) * 0.5)
                    .total_cmp(&(distance(pos, b.1) + (b.1[0] - ctx.wall()) * 0.5))
            });
        return best.map(|(i, p)| sweep.set(Some(i), stand(p), pos, tick));
    }
    let anchor = if goalkeep {
        ctx.exit()
    } else {
        [front_x(ctx), ctx.view.bounds.unwrap_or([0.0; 4])[3] / 2.0]
    };
    let mut outside = BTreeSet::new();
    loop {
        let mut best = None;
        for (distant, revisit) in [(true, false), (false, false), (false, true)] {
            let mut score = f64::INFINITY;
            for (i, &centre) in regions.iter().enumerate() {
                if !eligible(i, centre, revisit) || outside.contains(&i) {
                    continue;
                }
                let d = distance(pos, centre);
                if distant && !goalkeep && d < 2400.0
                    || goalkeep && distance(anchor, centre) > GOALKEEP_RADIUS
                {
                    continue;
                }
                let target_x = if goalkeep {
                    anchor[0]
                } else {
                    ctx.exit()[0].min(front_x(ctx) + d / 3.0)
                };
                let behind = if !goalkeep && centre[0] < front_x(ctx) {
                    (front_x(ctx) - centre[0]) * 3.0
                } else {
                    0.0
                };
                let value = (centre[0] - target_x).abs() * 2.0
                    + (centre[1] - anchor[1]).abs()
                    + d * 0.08
                    + repel(peers, ctx, id, centre)
                    + behind;
                if value < score {
                    score = value;
                    best = Some(i);
                }
            }
            if best.is_some() {
                break;
            }
        }
        let Some(i) = best else {
            return goalkeep.then(|| stand(ctx.exit()));
        };
        let point = stand(regions[i]);
        if goalkeep && distance(ctx.exit(), point) > GOALKEEP_RADIUS {
            outside.insert(i);
            continue;
        }
        return Some(sweep.set(Some(i), point, pos, tick));
    }
}

pub(super) fn transit(
    ctx: &Context<'_>,
    actor: &Actor,
    pos: Point,
    goal: Point,
) -> Option<(Point, StationId)> {
    let tick = ctx.view.tick;
    let mut speed = 8.0;
    if active_status(actor, Status::Boost, tick) {
        speed *= 1.5;
    }
    if active_status(actor, Status::Stun, tick) {
        speed *= 0.35;
    }
    let stations: Vec<_> = ctx
        .view
        .state
        .stations
        .iter()
        .filter(|(_, s)| s.kind == StationKind::Transit && s.position[0] > ctx.wall() + 40.0)
        .collect();
    let mut cost = distance(pos, goal) / speed;
    let mut best = None;
    for &(from_id, from) in &stations {
        let reach = distance(pos, from.position) / speed;
        if actor.deadlines.transit_ready_at.saturating_sub(tick) as f64 > reach {
            continue;
        }
        for &(to_id, to) in &stations {
            if from_id == to_id {
                continue;
            }
            let travel = (ctx.rules.interactions.transit_base
                + ctx.rules.interactions.transit_per_unit * distance(from.position, to.position))
            .round()
            .max(0.0);
            let via = reach + 60.0 + travel + distance(to.position, goal) / speed;
            if via < cost {
                cost = via;
                best = Some((from.position, *to_id));
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::super::Settings;
    use super::*;
    use crate::physics::{BodyParams, KIND_ACTOR, SHAPE_CIRCLE};
    use crate::runtime_navigation::RuntimeNavigation;
    use crate::tick::hearing::Cues;
    use crate::tick::{
        BodyId, BodySpec, CarriedItem, Combat, Deadlines, Equipment, Event, Extraction, Fact,
        Inventory, Scenario, Station, Tick, Window,
    };
    use std::rc::Rc;

    fn gladiator_id(seat: u32) -> ActorId {
        ActorId {
            kind: ActorKind::Gladiator,
            seat,
        }
    }

    fn contestant_id(seat: u32) -> ActorId {
        ActorId {
            kind: ActorKind::Contestant,
            seat,
        }
    }

    fn actor_record() -> Actor {
        Actor {
            presence: Presence::Active,
            kit: None,
            level: 1,
            kills: 0,
            hp: 100.0,
            max_hp: 100.0,
            shield: 0.0,
            max_shield: 75.0,
            aim: 0.0,
            sneak: false,
            view_lag: 0,
            inventory: Inventory::default(),
            charging: None,
            respawn_at: None,
            transit: None,
            bot: true,
            aggression: None,
            deadlines: Deadlines::default(),
            statuses: BTreeMap::new(),
        }
    }

    fn place_actor(scenario: &mut Scenario, id: ActorId, at: Point, actor: Actor) {
        scenario.state.actors.insert(id, actor);
        scenario.body(
            BodyId::Actor(id),
            BodySpec {
                params: BodyParams {
                    kind: KIND_ACTOR,
                    map_geometry: false,
                    pose: [at[0], at[1], 0.0, 0.0, 0.0, 0.0],
                    material: [1.0, 0.0, 0.0],
                    damping: [Some(0.0); 2],
                    groups: 0xffff_ffff,
                },
                shape: SHAPE_CIRCLE,
                dimensions: [12.0, 0.0],
                vertices: Vec::new(),
                speed_limit: 1_000.0,
                tip_radius: 0.0,
            },
        );
    }

    /// Ten 1152x1152 regions spanning a 11520x1152 arena, matching the 60x6 test arena.
    fn arena_regions() -> Vec<[f64; 4]> {
        (0..10)
            .map(|i| [i as f64 * 1152.0, 0.0, 1152.0, 1152.0])
            .collect()
    }

    fn arena_nav() -> Rc<RuntimeNavigation> {
        RuntimeNavigation::for_regions(11520.0, 1152.0, &arena_regions())
    }

    fn run_with<R>(
        hunting: Hunting,
        tick: Tick,
        hazard_x: f64,
        slots: u32,
        nav: Option<Rc<RuntimeNavigation>>,
        arrange: impl FnOnce(&mut Scenario, &mut Cues, &mut Combat),
        f: impl FnOnce(&Context<'_>) -> R,
    ) -> R {
        let mut scenario = Scenario::default();
        scenario.bounds([0.0, 0.0], [11520.0, 1152.0]);
        scenario.state.hazard_x = Some(hazard_x);
        scenario.state.extraction = Some(Extraction {
            position: [11200.0, 576.0],
            slots,
        });
        let mut cues = Cues::default();
        let mut rules = Combat::default();
        arrange(&mut scenario, &mut cues, &mut rules);
        let roster: Vec<_> = scenario
            .state
            .actors
            .keys()
            .copied()
            .enumerate()
            .map(|(rank, id)| (id, false, true, rank))
            .collect();
        let lexical: Vec<_> = roster.iter().map(|&(id, ..)| id).collect();
        let mut game = scenario.start(1, 10);
        let bodies = game.bodies.before_solve();
        let memory = BTreeMap::new();
        let settings = Settings {
            hunting,
            roster,
            ..Settings::default()
        };
        let ctx = Context {
            view: game.view(tick),
            bodies: &bodies,
            actor_bodies: &game.bodies,
            memory: &memory,
            cues: &cues,
            settings: &settings,
            lexical: &lexical,
            rules: &rules,
            roofs: None,
            navigation: nav.as_ref(),
            entry_x: 0.0,
        };
        f(&ctx)
    }

    #[test]
    fn transit_is_planned_only_when_faster_and_cooldown_spent() {
        let g = gladiator_id(0);
        let plan =
            |stations: &[(u32, Point)], pos: Point, goal: Point, hazard_x: f64, rail_cd: Tick| {
                run_with(
                    Hunting::Front,
                    100,
                    hazard_x,
                    3,
                    None,
                    |s, _, rules| {
                        rules.interactions.transit_base = 10.0;
                        rules.interactions.transit_per_unit = 0.008;
                        let mut actor = actor_record();
                        actor.deadlines.transit_ready_at = 100 + rail_cd;
                        place_actor(s, g, pos, actor);
                        for &(id, position) in stations {
                            s.state.stations.insert(
                                StationId(id),
                                Station {
                                    kind: StationKind::Transit,
                                    position,
                                },
                            );
                        }
                    },
                    |ctx| transit(ctx, &ctx.view.state.actors[&g], pos, goal),
                )
            };
        let all = [(0, [600.0, 0.0]), (1, [8000.0, 0.0]), (2, [4000.0, 3000.0])];
        assert_eq!(
            plan(&all, [500.0, 0.0], [8200.0, 0.0], -80.0, 0),
            Some(([600.0, 0.0], StationId(1))),
            "the station nearest the goal"
        );
        assert_eq!(
            plan(&all, [500.0, 0.0], [1500.0, 0.0], -80.0, 0),
            None,
            "a short walk is not worth it"
        );
        assert_eq!(
            plan(&all[..2], [500.0, 0.0], [8200.0, 0.0], -80.0, 200),
            None,
            "the cooldown would not be spent on arrival"
        );
        assert_eq!(
            plan(&all, [500.0, 0.0], [8200.0, 0.0], -80.0, 200),
            Some(([4000.0, 3000.0], StationId(1))),
            "station c is far enough away for the cooldown to be spent"
        );
        assert_eq!(
            plan(&all, [9000.0, 0.0], [9500.0, 0.0], 8500.0, 0),
            None,
            "stations behind the wall are not used"
        );
    }

    #[test]
    fn front_sweep_picks_coarse_regions_and_switches_to_goalkeep_on_evidence() {
        let nav = arena_nav();
        let g1 = gladiator_id(0);
        let g2 = gladiator_id(1);
        let c0 = contestant_id(0);
        let mut front = Front::default();
        let mut sweep1 = Sweep::default();
        let first = run_with(
            Hunting::Front,
            100,
            -80.0,
            3,
            Some(Rc::clone(&nav)),
            |s, _, _| {
                place_actor(s, g1, [10500.0, 576.0], actor_record());
                place_actor(s, c0, [960.0, 576.0], actor_record());
            },
            |ctx| {
                front.update(ctx);
                assert!(!front.further_right);
                let target = target(
                    ctx,
                    &mut front,
                    g1,
                    [10500.0, 576.0],
                    &mut sweep1,
                    &BTreeMap::new(),
                    |p| p,
                )
                .expect("picked a sweep target");
                assert!(distance([10500.0, 576.0], target) >= 2400.0);
                assert!(target[0] >= front_x(ctx) && target[0] <= 10500.0);
                target
            },
        );
        assert!(first[0] > 0.0);

        let mut sweep2 = Sweep::default();
        let keep = run_with(
            Hunting::Front,
            101,
            -80.0,
            3,
            Some(nav),
            |s, cues, _| {
                place_actor(s, g1, [10500.0, 576.0], actor_record());
                place_actor(s, g2, [6000.0, 576.0], actor_record());
                place_actor(s, c0, [960.0, 576.0], actor_record());
                cues.publish(&[Event {
                    id: 0,
                    tick: 101,
                    fact: Fact::Heard {
                        listener: g2,
                        at: [11200.0 - 300.0, 576.0].into(),
                        until: 200,
                    },
                }]);
            },
            |ctx| {
                front.update(ctx);
                assert!(front.further_right);
                target(
                    ctx,
                    &mut front,
                    g2,
                    [6000.0, 576.0],
                    &mut sweep2,
                    &BTreeMap::new(),
                    |p| p,
                )
                .expect("goalkeeping target")
            },
        );
        assert!(keep[0] > 11200.0 - GOALKEEP_RADIUS);
    }

    #[test]
    fn front_evidence_checks_each_branch() {
        let g = gladiator_id(0);
        let c = contestant_id(0);
        let threshold = 520.0 + 1600.0; // front_x at tick 100 with hazard_x -80 is 520.0

        fn check(tick: Tick, slots: u32, arrange: impl FnOnce(&mut Scenario, &mut Cues)) -> bool {
            let mut front = Front::default();
            run_with(
                Hunting::Front,
                tick,
                -80.0,
                slots,
                None,
                |s, cues, _| arrange(s, cues),
                |ctx| {
                    front.update(ctx);
                    front.further_right
                },
            )
        }

        assert!(
            check(100, 2, |s, _| {
                place_actor(s, g, [500.0, 576.0], actor_record());
            }),
            "claimed escape pod latches evidence"
        );

        assert!(
            check(20000, 3, |s, _| {
                place_actor(s, g, [500.0, 576.0], actor_record());
            }),
            "front reaching exit latches evidence"
        );

        assert!(
            check(100, 3, |s, _| {
                place_actor(
                    s,
                    gladiator_id(0),
                    [threshold + 50.0, 576.0],
                    actor_record(),
                );
                place_actor(
                    s,
                    contestant_id(0),
                    [threshold + 100.0, 576.0],
                    actor_record(),
                );
            }),
            "sighted contestant beyond threshold latches evidence"
        );

        assert!(
            !check(100, 3, |s, _| {
                place_actor(s, gladiator_id(0), [500.0, 576.0], actor_record());
                place_actor(s, contestant_id(0), [600.0, 576.0], actor_record());
            }),
            "sighted contestant behind threshold does not latch"
        );

        assert!(
            check(100, 3, |s, _| {
                place_actor(s, gladiator_id(0), [500.0, 576.0], actor_record());
                let mut actor = actor_record();
                actor.statuses.insert(
                    Status::Reveal,
                    Window {
                        active_from: 0,
                        expires_at: 150,
                    },
                );
                place_actor(s, contestant_id(0), [threshold + 200.0, 576.0], actor);
            }),
            "revealed contestant beyond threshold latches evidence"
        );

        assert!(
            check(100, 3, |s, cues| {
                place_actor(s, g, [500.0, 576.0], actor_record());
                cues.publish(&[Event {
                    id: 0,
                    tick: 100,
                    fact: Fact::Heard {
                        listener: g,
                        at: [threshold + 300.0, 576.0].into(),
                        until: 200,
                    },
                }]);
            }),
            "heard shot beyond threshold latches evidence"
        );

        assert!(
            !check(100, 3, |s, cues| {
                place_actor(s, g, [500.0, 576.0], actor_record());
                cues.publish(&[Event {
                    id: 0,
                    tick: 100,
                    fact: Fact::Heard {
                        listener: g,
                        at: [600.0, 576.0].into(),
                        until: 200,
                    },
                }]);
            }),
            "heard shot behind threshold does not latch"
        );
        let _ = c;
    }

    #[test]
    fn powered_cell_directs_gladiator_to_charging_station_rather_than_exit() {
        let nav = arena_nav();
        let g = gladiator_id(0);
        let c = contestant_id(0);
        let mut front = Front::default();
        let mut sweep = Sweep::default();
        run_with(
            Hunting::Front,
            100,
            -80.0,
            3,
            Some(Rc::clone(&nav)),
            |s, _, rules| {
                rules.interactions.charge_ticks = 100;
                s.state.stations.insert(
                    StationId(0),
                    Station {
                        kind: StationKind::Charging,
                        position: [3840.0, 576.0],
                    },
                );
                s.state.stations.insert(
                    StationId(1),
                    Station {
                        kind: StationKind::Charging,
                        position: [7680.0, 576.0],
                    },
                );
                place_actor(s, g, [10500.0, 576.0], actor_record());
                let mut contestant = actor_record();
                contestant.inventory.slots[0] = Some(CarriedItem {
                    id: ItemId(1),
                    lineage: ItemId(1),
                    equipment: Equipment {
                        kind: EquipmentKind::Cell { charge: 100 },
                        quality: 0,
                    },
                });
                place_actor(s, c, [3850.0, 576.0], contestant);
            },
            |ctx| {
                front.update(ctx);
                assert!(!front.further_right);
                let picked = target(
                    ctx,
                    &mut front,
                    g,
                    [10500.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .expect("picked investigation target");
                assert_eq!(picked[0], 3840.0);
                let after = target(
                    ctx,
                    &mut front,
                    g,
                    [3840.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .expect("resumed sweeping after checking charger");
                assert_ne!(after[0], 3840.0);
            },
        );
    }

    #[test]
    fn targetless_gladiators_repel_each_other_while_targeted_do_not() {
        let nav = arena_nav();
        let peer = gladiator_id(0);
        let seeker = gladiator_id(1);
        let front_region_x = run_with(
            Hunting::Front,
            1380,
            -80.0,
            3,
            Some(Rc::clone(&nav)),
            |s, _, _| {
                place_actor(s, seeker, [10500.0, 576.0], actor_record());
            },
            |ctx| {
                let mut front = Front::default();
                let mut sweep = Sweep::default();
                front.update(ctx);
                target(
                    ctx,
                    &mut front,
                    seeker,
                    [10500.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .unwrap()[0]
            },
        );
        let pick_with_peer = |targeted: bool| {
            run_with(
                Hunting::Front,
                1380,
                -80.0,
                3,
                Some(Rc::clone(&nav)),
                |s, _, _| {
                    place_actor(s, peer, [front_region_x, 576.0], actor_record());
                    place_actor(s, seeker, [10500.0, 576.0], actor_record());
                },
                |ctx| {
                    let mut front = Front::default();
                    let mut sweep = Sweep::default();
                    let mut peers = BTreeMap::new();
                    let mut peer_bot = Bot::default();
                    peer_bot.sweeping.targeted = targeted;
                    peers.insert(peer, peer_bot);
                    front.update(ctx);
                    target(
                        ctx,
                        &mut front,
                        seeker,
                        [10500.0, 576.0],
                        &mut sweep,
                        &peers,
                        |p| p,
                    )
                    .unwrap()[0]
                },
            )
        };
        let repelled = pick_with_peer(false);
        let unrepelled = pick_with_peer(true);
        assert_eq!(unrepelled, front_region_x);
        assert_ne!(repelled, unrepelled);
    }

    #[test]
    fn sweep_target_is_dropped_when_hazard_wall_passes_it() {
        let nav = arena_nav();
        let g = gladiator_id(0);
        let mut front = Front::default();
        let mut sweep = Sweep::default();
        let target1 = run_with(
            Hunting::Front,
            100,
            -80.0,
            3,
            Some(Rc::clone(&nav)),
            |s, _, _| place_actor(s, g, [5000.0, 576.0], actor_record()),
            |ctx| {
                front.update(ctx);
                target(
                    ctx,
                    &mut front,
                    g,
                    [5000.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .unwrap()
            },
        );
        let hazard = target1[0] - 500.0;
        let target2 = run_with(
            Hunting::Front,
            101,
            hazard,
            3,
            Some(nav),
            |s, _, _| place_actor(s, g, [5000.0, 576.0], actor_record()),
            |ctx| {
                front.update(ctx);
                target(
                    ctx,
                    &mut front,
                    g,
                    [5000.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .unwrap()
            },
        );
        assert_ne!(target2[0], target1[0]);
        assert!(target2[0] >= hazard + AHEAD);
    }

    #[test]
    fn sweep_target_is_dropped_when_goalkeeping_latches_far_from_exit() {
        let nav = arena_nav();
        let g = gladiator_id(0);
        let mut front = Front::default();
        let mut sweep = Sweep::default();
        let target1 = run_with(
            Hunting::Front,
            100,
            -80.0,
            3,
            Some(Rc::clone(&nav)),
            |s, _, _| place_actor(s, g, [5000.0, 576.0], actor_record()),
            |ctx| {
                front.update(ctx);
                target(
                    ctx,
                    &mut front,
                    g,
                    [5000.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .unwrap()
            },
        );
        assert!((target1[0] - 11200.0).abs() > GOALKEEP_RADIUS);
        let mut front2 = Front::default();
        let target2 = run_with(
            Hunting::Front,
            101,
            -80.0,
            2,
            Some(nav),
            |s, _, _| place_actor(s, g, [5000.0, 576.0], actor_record()),
            |ctx| {
                front2.update(ctx);
                target(
                    ctx,
                    &mut front2,
                    g,
                    [5000.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .unwrap()
            },
        );
        assert_ne!(target2[0], target1[0]);
        assert!((target2[0] - 11200.0).abs() <= GOALKEEP_RADIUS);
    }

    #[test]
    fn goalkeeper_patrols_within_exit_radius_and_revisits() {
        let nav = arena_nav();
        let g = gladiator_id(0);
        let mut sweep = Sweep::default();
        let mut pos = [11200.0 - 1500.0, 576.0];
        for leg in 0..16 {
            let mut front = Front::default();
            let picked = run_with(
                Hunting::Front,
                100 + leg,
                -80.0,
                2,
                Some(Rc::clone(&nav)),
                |s, _, _| place_actor(s, g, pos, actor_record()),
                |ctx| {
                    front.update(ctx);
                    target(ctx, &mut front, g, pos, &mut sweep, &BTreeMap::new(), |p| p)
                        .expect("goalkeeper target")
                },
            );
            assert!(distance(picked, [11200.0, 576.0]) <= GOALKEEP_RADIUS);
            pos = picked;
        }
    }

    #[test]
    fn goalkeeper_never_keeps_standing_point_outside_exit_radius() {
        let nav = arena_nav();
        let g = gladiator_id(0);
        let mut sweep = Sweep::default();
        let mut pos = [11200.0 - 1500.0, 576.0];
        let mut saw_pushed_boundary = false;
        let push = 1000.0;
        for leg in 0..16 {
            let mut front = Front::default();
            let picked = run_with(
                Hunting::Front,
                100 + leg,
                -80.0,
                2,
                Some(Rc::clone(&nav)),
                |s, _, _| place_actor(s, g, pos, actor_record()),
                |ctx| {
                    front.update(ctx);
                    target(
                        ctx,
                        &mut front,
                        g,
                        pos,
                        &mut sweep,
                        &BTreeMap::new(),
                        |at| {
                            let d = distance(at, [11200.0, 576.0]);
                            if d <= GOALKEEP_RADIUS && d + push > GOALKEEP_RADIUS {
                                saw_pushed_boundary = true;
                            }
                            let sign = if at[0] >= 11200.0 { 1.0 } else { -1.0 };
                            [at[0] + sign * push, at[1]]
                        },
                    )
                    .expect("goalkeeper target")
                },
            );
            assert!(distance(picked, [11200.0, 576.0]) <= GOALKEEP_RADIUS);
            pos = picked;
        }
        assert!(saw_pushed_boundary);
    }

    #[test]
    fn give_up_clears_target_even_when_region_is_none() {
        let nav = arena_nav();
        let g = gladiator_id(0);
        let c = contestant_id(0);
        let mut front = Front::default();
        let mut sweep = Sweep::default();
        run_with(
            Hunting::Front,
            100,
            -80.0,
            3,
            Some(nav),
            |s, _, rules| {
                rules.interactions.charge_ticks = 100;
                s.state.stations.insert(
                    StationId(0),
                    Station {
                        kind: StationKind::Charging,
                        position: [3840.0, 576.0],
                    },
                );
                place_actor(s, g, [10500.0, 576.0], actor_record());
                let mut contestant = actor_record();
                contestant.inventory.slots[0] = Some(CarriedItem {
                    id: ItemId(1),
                    lineage: ItemId(1),
                    equipment: Equipment {
                        kind: EquipmentKind::Cell { charge: 100 },
                        quality: 0,
                    },
                });
                place_actor(s, c, [3850.0, 576.0], contestant);
            },
            |ctx| {
                front.update(ctx);
                let mut stands = 0;
                let first = target(
                    ctx,
                    &mut front,
                    g,
                    [10500.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| {
                        stands += 1;
                        p
                    },
                )
                .unwrap();
                assert_eq!(stands, 1);
                assert!(sweep.region.is_none());
                sweep.give_up(100);
                let next = target(
                    ctx,
                    &mut front,
                    g,
                    [10500.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| {
                        stands += 1;
                        p
                    },
                )
                .unwrap();
                assert_eq!(stands, 2);
                assert_eq!(next, first);
            },
        );
    }

    #[test]
    fn sweep_mode_retains_target_when_hazard_wall_passes_it() {
        let nav = arena_nav();
        let g = gladiator_id(0);
        let mut front = Front::default();
        let mut sweep = Sweep::default();
        let target1 = run_with(
            Hunting::Sweep,
            100,
            -80.0,
            3,
            Some(Rc::clone(&nav)),
            |s, _, _| place_actor(s, g, [4500.0, 576.0], actor_record()),
            |ctx| {
                target(
                    ctx,
                    &mut front,
                    g,
                    [4500.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .unwrap()
            },
        );
        let target2 = run_with(
            Hunting::Sweep,
            101,
            target1[0] + 500.0,
            3,
            Some(nav),
            |s, _, _| place_actor(s, g, [4500.0, 576.0], actor_record()),
            |ctx| {
                target(
                    ctx,
                    &mut front,
                    g,
                    [4500.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .unwrap()
            },
        );
        assert_eq!(target2, target1);
    }

    #[test]
    fn front_mode_preserves_charger_investigation_under_goalkeeping() {
        let nav = arena_nav();
        let g = gladiator_id(0);
        let c = contestant_id(0);
        let mut front = Front::default();
        let mut sweep = Sweep::default();
        let arrange = |s: &mut Scenario, rules: &mut Combat| {
            rules.interactions.charge_ticks = 100;
            s.state.stations.insert(
                StationId(0),
                Station {
                    kind: StationKind::Charging,
                    position: [3840.0, 576.0],
                },
            );
            place_actor(s, g, [10500.0, 576.0], actor_record());
            let mut contestant = actor_record();
            contestant.inventory.slots[0] = Some(CarriedItem {
                id: ItemId(1),
                lineage: ItemId(1),
                equipment: Equipment {
                    kind: EquipmentKind::Cell { charge: 100 },
                    quality: 0,
                },
            });
            place_actor(s, c, [3850.0, 576.0], contestant);
        };
        let target1 = run_with(
            Hunting::Front,
            100,
            -80.0,
            2,
            Some(Rc::clone(&nav)),
            |s, _, rules| arrange(s, rules),
            |ctx| {
                front.update(ctx);
                assert!(front.further_right);
                target(
                    ctx,
                    &mut front,
                    g,
                    [10500.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .unwrap()
            },
        );
        assert_eq!(target1[0], 3840.0);
        let target2 = run_with(
            Hunting::Front,
            101,
            -80.0,
            2,
            Some(nav),
            |s, _, rules| arrange(s, rules),
            |ctx| {
                front.update(ctx);
                target(
                    ctx,
                    &mut front,
                    g,
                    [10500.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .unwrap()
            },
        );
        assert_eq!(target2, target1);
    }

    #[test]
    fn sweep_target_is_dropped_when_advancing_front_passes_it() {
        let nav = arena_nav();
        let g = gladiator_id(0);
        let mut front = Front::default();
        let mut sweep = Sweep::default();
        let target1 = run_with(
            Hunting::Front,
            100,
            -80.0,
            3,
            Some(Rc::clone(&nav)),
            |s, _, _| place_actor(s, g, [5000.0, 576.0], actor_record()),
            |ctx| {
                front.update(ctx);
                target(
                    ctx,
                    &mut front,
                    g,
                    [5000.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .unwrap()
            },
        );
        let target2 = run_with(
            Hunting::Front,
            3000,
            -80.0,
            3,
            Some(nav),
            |s, _, _| place_actor(s, g, [5000.0, 576.0], actor_record()),
            |ctx| {
                front.update(ctx);
                target(
                    ctx,
                    &mut front,
                    g,
                    [5000.0, 576.0],
                    &mut sweep,
                    &BTreeMap::new(),
                    |p| p,
                )
                .unwrap()
            },
        );
        assert_ne!(target2[0], target1[0]);
    }
}
