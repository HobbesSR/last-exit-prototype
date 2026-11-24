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
