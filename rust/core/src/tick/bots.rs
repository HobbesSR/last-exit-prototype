use std::rc::Rc;

use crate::{
    collision::{CollisionMap, can_occupy, line_clear_with_gates, reach_clear_with_gates},
    discovery::Roofs,
    math::{atan2, cos, distance, hypot, sin},
    navigation::{Grid, Knowledge, RouteStatus, closest},
    runtime_navigation::RuntimeNavigation,
};

use super::*;

mod dynamic;
mod hunting;
mod objectives;
mod routes;
mod steering_sweep;

#[derive(Default, Clone, Copy, PartialEq, Eq)]
pub enum Hunting {
    #[default]
    None,
    Sweep,
    Front,
}

#[derive(Default)]
pub struct Settings {
    pub hearing: bool,
    pub hunting: Hunting,
    pub portals: bool,
    pub selectable_transit: bool,
    // Roster order, temperament, equipment availability, and lexical label rank.
    pub roster: Vec<(ActorId, bool, bool, usize)>,
}

#[derive(Default)]
pub(super) struct BotMap {
    pub entry_x: f64,
    pub collision: Option<CollisionMap>,
    pub roofs: Option<Arc<Roofs>>,
    pub navigation: Option<Rc<RuntimeNavigation>>,
}

#[derive(Default)]
pub(super) struct Planner {
    pub map: BotMap,
    settings: Settings,
    lexical: Vec<ActorId>,
    occupied_gates: Option<GateSet>,
    actors: BTreeMap<ActorId, Bot>,
    hunting: hunting::Front,
}

#[derive(Default)]
struct Bot {
    route: routes::RouteState,
    detour: dynamic::Detour,
    pursuit: objectives::Pursuit,
    lead: Option<Lead>,
    sweeping: hunting::Sweep,
}

struct Lead {
    at: Point,
    heard: Tick,
    since: Tick,
    closest: f64,
    progressed: Tick,
    done: bool,
}

impl Planner {
    pub fn route(&self, id: ActorId) -> &[Point] {
        self.actors
            .get(&id)
            .map_or(&[], |bot| bot.route.route.as_slice())
    }

    pub fn routes(&self) -> impl Iterator<Item = (ActorId, u64, &[Point])> {
        self.actors.iter().filter_map(|(&id, bot)| {
            bot.route
                .has_plan()
                .then_some((id, bot.route.generation, &bot.route.route[..]))
        })
    }

    pub fn clear_route(&mut self, id: ActorId) {
        if let Some(bot) = self.actors.get_mut(&id) {
            bot.route.clear_route();
        }
    }

    pub fn new(
        settings: Settings,
        entry_x: f64,
        collision: Option<CollisionMap>,
        roofs: Option<Arc<Roofs>>,
    ) -> Self {
        let mut lexical = settings.roster.clone();
        lexical.sort_by_key(|&(_, _, _, rank)| rank);
        Self {
            map: BotMap {
                entry_x,
                collision,
                roofs,
                navigation: None,
            },
            settings,
            lexical: lexical.into_iter().map(|(id, ..)| id).collect(),
            ..Self::default()
        }
    }
}

struct Context<'a> {
    view: View<'a>,
    bodies: &'a BeforeSolve,
    actor_bodies: &'a Bodies,
    memory: &'a BTreeMap<ActorId, Memory>,
    cues: &'a hearing::Cues,
    settings: &'a Settings,
    lexical: &'a [ActorId],
    rules: &'a Combat,
    roofs: Option<&'a Roofs>,
    navigation: Option<&'a Rc<RuntimeNavigation>>,
    entry_x: f64,
}

impl Context<'_> {
    fn point(&self, id: ActorId) -> Option<Point> {
        self.bodies.position(BodyId::Actor(id))
    }

    fn radius(&self, id: ActorId) -> f64 {
        self.actor_bodies
            .actor_spec(id)
            .map_or(12.0, |spec| spec.dimensions[0])
    }

    fn wall(&self) -> f64 {
        self.view.state.hazard_x.unwrap_or(f64::NEG_INFINITY)
    }

    fn exit(&self) -> Point {
        self.view
            .state
            .extraction
            .map_or([0.0, 0.0], |exit| exit.position)
    }

    fn grid(&self) -> Grid {
        let [_, _, width, height] = self.view.bounds.unwrap_or([0.0; 4]);
        Grid::discovery(width, height)
    }

    fn cell_at(&self, point: Point) -> Option<u32> {
        self.grid().cell_at(point).map(|cell| cell as u32)
    }

    fn centre(&self, cell: u32) -> Point {
        self.grid().centre(cell as usize)
    }

    fn line(&self, a: Point, b: Point) -> bool {
        line_clear_with_gates(
            self.view.sight,
            self.view.sight_gates,
            (a[0], a[1]),
            (b[0], b[1]),
            |i| self.gate_open(i),
        )
        .0
    }

    fn gate_open(&self, slot: usize) -> bool {
        self.view
            .state
            .gates
            .get(&GateId(slot as u32))
            .is_some_and(|g| g.open)
    }

    fn visible_point(&self, a: Point, b: Point) -> bool {
        if distance(a, b) >= 620.0 {
            return false;
        }
        if let Some(roofs) = self.roofs
            && let Some(roof) = roofs.roof_at(b[0], b[1])
            && roofs.roof_at(a[0], a[1]) != Some(roof)
        {
            return false;
        }
        self.line(a, b)
    }

    fn visible(&self, id: ActorId, other: ActorId) -> bool {
        let actor = &self.view.state.actors[&other];
        if id.kind == ActorKind::Gladiator && active_status(actor, Status::Reveal, self.view.tick) {
            return true;
        }
        !active_status(actor, Status::Cloak, self.view.tick)
            && self
                .point(id)
                .zip(self.point(other))
                .is_some_and(|(a, b)| self.visible_point(a, b))
    }

    fn swept_clear(
        &self,
        collision: Option<&CollisionMap>,
        actor: Option<ActorId>,
        a: Point,
        b: Point,
        radius: f64,
    ) -> bool {
        steering_sweep::clear(collision, self.view.sight_gates, a, b, radius, |i| {
            if let Some(memory) = actor.and_then(|id| self.memory.get(&id)) {
                memory
                    .gates
                    .get(&GateId(i as u32))
                    .is_none_or(|gate| gate.open)
            } else {
                self.gate_open(i)
            }
        })
    }
}

fn active_status(actor: &Actor, status: Status, tick: Tick) -> bool {
    // The committed countdown already exposes statuses whose resolution starts next tick.
    actor.statuses.get(&status).is_some_and(|window| {
        window.active_from <= tick.saturating_add(1) && window.expires_at > tick
    })
}

fn clearance(id: ActorId) -> f64 {
    if id.kind == ActorKind::Contestant {
        14.0
    } else {
        25.0
    }
}

fn route_body_radius(id: ActorId) -> f64 {
    clearance(id) - 2.0
}

fn occupy(
    collision: &mut Option<CollisionMap>,
    gates: &mut GateSet,
    p: Point,
    radius: f64,
    ignore_gates: bool,
) -> bool {
    collision
        .as_mut()
        .is_none_or(|map| can_occupy(map, gates, p[0], p[1], radius, ignore_gates, false))
}

fn standing(
    ctx: &Context<'_>,
    collision: &mut Option<CollisionMap>,
    gates: &mut GateSet,
    id: ActorId,
    at: Point,
) -> Point {
    let memory = ctx.memory.get(&id);
    if let Some(memory) = memory
        && ctx.cell_at(at).is_none_or(|cell| {
            !memory.discovered.contains(&cell) && !memory.surveyed.contains(&cell)
        })
    {
        return at;
    }
    let radius = clearance(id);
    let reach = if memory.is_some() {
        96.0 - radius
    } else {
        f64::INFINITY
    };
    let mut offsets = Vec::with_capacity(49);
    for y in -3..=3 {
        for x in -3..=3 {
            offsets.push((x * x + y * y, x, y));
        }
    }
    offsets.sort_by_key(|&(length, ..)| length);
    for (_, dx, dy) in offsets {
        let (dx, dy) = (f64::from(dx) * 32.0, f64::from(dy) * 32.0);
        let point = [at[0] + dx, at[1] + dy];
        if dx.abs() <= reach
            && dy.abs() <= reach
            && occupy(collision, gates, point, radius, memory.is_some())
        {
            return point;
        }
    }
    at
}

fn passed(
    ctx: &Context<'_>,
    collision: Option<&CollisionMap>,
    id: ActorId,
    at: Point,
    waypoint: Point,
    next: Point,
) -> bool {
    let d = distance(at, waypoint);
    if d < 2.0 {
        return true;
    }
    if d >= 11.0 {
        return false;
    }
    let radius = route_body_radius(id);
    if distance(at, closest(at, waypoint, next)) > clearance(id) - radius {
        return false;
    }
    let t = (24.0 / distance(at, next).max(1e-9)).min(1.0);
    ctx.swept_clear(
        collision,
        None,
        at,
        [at[0] + (next[0] - at[0]) * t, at[1] + (next[1] - at[1]) * t],
        radius,
    )
}

fn lead(
    ctx: &Context<'_>,
    collision: &mut Option<CollisionMap>,
    gates: &mut GateSet,
    id: ActorId,
    pos: Point,
    state: &mut Option<Lead>,
) -> Option<Point> {
    let tick = ctx.view.tick;
    if let Some(cue) = ctx.cues.heard(id, tick).last()
        && state.as_ref().is_none_or(|lead| cue.tick > lead.heard)
    {
        *state = Some(Lead {
            at: standing(ctx, collision, gates, id, cue.at),
            heard: cue.tick,
            since: tick,
            closest: f64::INFINITY,
            progressed: tick,
            done: false,
        });
    }
    let lead = state.as_mut()?;
    if lead.done {
        return None;
    }
    let d = distance(pos, lead.at);
    if d < 400.0 || tick - lead.since > 1200 {
        lead.done = true;
        return None;
    }
    if d < lead.closest - 16.0 {
        lead.closest = d;
        lead.progressed = tick;
    } else if tick - lead.progressed > 200 {
        lead.done = true;
        return None;
    }
    Some(lead.at)
}

pub(super) fn collect(
    game: &mut Match,
    rules: &Combat,
    tick: Tick,
    inbound: &[Inbound],
) -> Vec<Command> {
    let mut planner = std::mem::take(&mut game.bots);
    let mut controllers = BTreeMap::new();
    let mut submitted = BTreeSet::new();
    for row in inbound {
        match *row {
            Inbound::Observation(Observation::Join {
                actor, bot_label, ..
            }) => {
                controllers.insert(actor, false);
                planner.clear_route(actor);
                // The server ranks each label just after binding it. Apply these ranks in
                // observation order, including when several bindings reach the same tick.
                if let Some((rank, opportunistic)) = bot_label
                    && let Some(seat) = planner
                        .settings
                        .roster
                        .iter_mut()
                        .find(|seat| seat.0 == actor)
                    && let Some(previous) = planner.lexical.iter().position(|&id| id == actor)
                {
                    seat.1 = opportunistic;
                    planner.lexical.remove(previous);
                    planner
                        .lexical
                        .insert(rank.min(planner.lexical.len()), actor);
                }
            }
            Inbound::Observation(Observation::Leave { actor }) => {
                controllers.insert(actor, true);
            }
            Inbound::Command(command) => {
                submitted.insert(command.actor);
            }
            _ => {}
        }
    }
    let ids: Vec<_> = planner
        .settings
        .roster
        .iter()
        .enumerate()
        .filter(|(_, (id, ..))| {
            game.state.actors.get(id).is_some_and(|actor| {
                actor.presence == Presence::Active
                    && controllers.get(id).copied().unwrap_or(actor.bot)
            }) && !submitted.contains(id)
        })
        .collect();
    let mut commands = Vec::with_capacity(ids.len());
    if !ids.is_empty() {
        let bodies = game.bodies.before_solve();
        let no_memory = BTreeMap::new();
        let ctx = Context {
            view: game.view(game.tick),
            bodies: &bodies,
            actor_bodies: &game.bodies,
            memory: if game.sampler.is_some() {
                &game.memory
            } else {
                &no_memory
            },
            cues: &game.cues,
            settings: &planner.settings,
            lexical: &planner.lexical,
            rules,
            roofs: planner.map.roofs.as_deref(),
            navigation: planner.map.navigation.as_ref(),
            entry_x: planner.map.entry_x,
        };
        let gates = planner
            .occupied_gates
            .get_or_insert_with(|| game.sight_gates.as_ref().clone());
        for (i, open) in gates.open.iter_mut().enumerate() {
            *open = u8::from(ctx.gate_open(i));
        }
        let gate_positions = ctx
            .view
            .state
            .gates
            .iter()
            .map(|(&id, gate)| (id, gate.position))
            .collect();
        let mut route_allowance = 3000;
        let mut detour_edges = 0;
        for (index, &(id, opportunistic, inventory, _)) in ids {
            let Some(pos) = ctx.point(id) else { continue };
            let mut bot = planner.actors.remove(&id).unwrap_or_default();
            let input = intent(
                &ctx,
                &mut planner.map.collision,
                gates,
                &mut planner.hunting,
                &planner.actors,
                &mut bot,
                &gate_positions,
                id,
                index,
                opportunistic,
                inventory,
                pos,
                &mut route_allowance,
                &mut detour_edges,
            );
            planner.actors.insert(id, bot);
            let seq = game.input.acknowledged(id).map_or(0, |seq| seq + 1);
            commands.push(Command {
                actor: id,
                source: CommandSource::Bot,
                tick,
                seq,
                input,
            });
        }
    }
    game.bots = planner;
    commands
}

#[allow(clippy::too_many_arguments)]
fn intent(
    ctx: &Context<'_>,
    collision: &mut Option<CollisionMap>,
    gates: &mut GateSet,
    front: &mut hunting::Front,
    peers: &BTreeMap<ActorId, Bot>,
    bot: &mut Bot,
    gate_positions: &BTreeMap<GateId, Point>,
    id: ActorId,
    index: usize,
    opportunistic: bool,
    inventory: bool,
    pos: Point,
    route_allowance: &mut usize,
    detour_edges: &mut usize,
) -> Input {
    let tick = ctx.view.tick;
    let actor = &ctx.view.state.actors[&id];
    let contestant = id.kind == ActorKind::Contestant;
    let nearest = ctx
        .settings
        .roster
        .iter()
        .filter_map(|&(other, ..)| {
            let target = &ctx.view.state.actors[&other];
            let at = ctx.point(other)?;
            let d = distance(pos, at);
            (other != id
                && target.presence == Presence::Active
                && (other.kind != id.kind
                    || actor
                        .aggression
                        .is_some_and(|a| a.source == other && tick < a.expires_at)
                    || contestant
                        && opportunistic
                        && tick > 600
                        && d < if tick > 2400 { 320.0 } else { 180.0 })
                && ctx.visible(id, other))
            .then_some((other, at, d))
        })
        .min_by(|a, b| a.2.total_cmp(&b.2));

    let lead = if ctx.settings.hearing && (!contestant || opportunistic) {
        lead(ctx, collision, gates, id, pos, &mut bot.lead)
    } else {
        None
    };
    let hunt = !contestant && ctx.settings.hunting != Hunting::None;
    let mut sweep = None;
    if hunt {
        bot.sweeping.targeted = nearest.is_some() || lead.is_some();
        front.update(ctx);
        if !bot.sweeping.targeted {
            sweep = hunting::target(ctx, front, id, pos, &mut bot.sweeping, peers, |at| {
                standing(ctx, collision, gates, id, at)
            });
        }
    }
    let mut target = ctx.exit();
    let mut transit = None;
    if !contestant {
        target = nearest
            .map(|(_, at, _)| at)
            .or(lead)
            .or(sweep)
            .or_else(|| {
                ctx.view
                    .state
                    .stations
                    .values()
                    .find(|s| s.kind == StationKind::Transit && s.position[0] > ctx.wall() + 1200.0)
                    .map(|s| s.position)
            })
            .unwrap_or(target);
        if hunt
            && nearest.is_none()
            && let Some((from, to)) = hunting::transit(ctx, actor, pos, target)
        {
            target = from;
            if ctx.settings.selectable_transit
                && actor.deadlines.transit_ready_at <= tick
                && distance(pos, from) < 70.0
            {
                transit = Some(to);
            }
        }
    }

    let mut equipment = objectives::EquipmentIntent::new(ctx, id, inventory);
    let mut exploring = false;
    let mut item = None;
    if contestant {
        let choice = objectives::choose(
            ctx,
            collision.as_ref(),
            id,
            pos,
            lead,
            opportunistic,
            nearest.map(|(_, _, d)| d),
            &mut bot.pursuit,
            &mut equipment,
        );
        (target, exploring, item) = choice;
        if !exploring && bot.pursuit.track_item(tick, pos, item.map(|i| (i, target))) {
            bot.route.clear_route();
        }
    }
    let mut input = equipment.input;
    let memory = ctx.memory.get(&id);
    if let Some(nav) = ctx.navigation {
        let leg = if !contestant && ctx.settings.portals {
            bot.route.leg_goal(nav, pos, target)
        } else {
            target
        };
        let keys = actor.inventory.keys as usize;
        let no_doors = BTreeMap::new();
        let knowledge = match memory {
            Some(memory) => Knowledge::contestant(nav, memory, keys),
            None => Knowledge::complete(nav, &ctx.view.state.gates, keys, 0),
        };
        let status = bot.route.repath(
            Rc::clone(nav),
            clearance(id),
            route_body_radius(id),
            knowledge,
            memory.map_or(&no_doors, |m| &m.gates),
            gate_positions,
            contestant && memory.is_some(),
            pos,
            leg,
            tick,
            index,
            route_allowance,
        );
        if matches!(
            status,
            Some(RouteStatus::NoKnownRoute | RouteStatus::InvalidEndpoint)
        ) {
            if leg != target {
                bot.route.abandon_leg();
            }
            if exploring {
                bot.pursuit.abandon();
            }
            if nearest.is_none() {
                if (lead.is_some() && !contestant || lead == Some(target))
                    && let Some(lead) = &mut bot.lead
                {
                    lead.done = true;
                }
                if lead.is_none() && sweep.is_some() {
                    bot.sweeping.give_up(tick);
                }
            }
            if let Some(id) = item
                && memory.is_some()
            {
                bot.pursuit.ignore(id, tick);
                bot.route.clear_route();
            }
        }
    }
    let waypoint = if distance(pos, target) < 55.0 && ctx.line(pos, target) {
        target
    } else {
        while let Some(&point) = bot.route.route.first() {
            let next = bot.route.route.get(1).copied().unwrap_or(target);
            if !passed(ctx, collision.as_ref(), id, pos, point, next) {
                break;
            }
            bot.route.route.remove(0);
        }
        bot.route.route.first().copied().unwrap_or(target)
    };
    let [mut dx, mut dy] = [waypoint[0] - pos[0], waypoint[1] - pos[1]];
    if contestant
        && let Some(hunter) = ctx.settings.roster.iter().find_map(|&(other, ..)| {
            let at = ctx.point(other)?;
            (other.kind == ActorKind::Gladiator
                && ctx.view.state.actors[&other].presence == Presence::Active
                && distance(pos, at) < 170.0
                && ctx.visible(id, other))
            .then_some(at)
        })
    {
        let away = atan2(pos[1] - hunter[1], pos[0] - hunter[0]);
        let length = hypot(dx, dy).max(1.0);
        let mut best = f64::NEG_INFINITY;
        let mut motion = None;
        for offset in [0.0, -0.5, 0.5, -1.0, 1.0, -1.5, 1.5] {
            let (x, y) = (cos(away + offset), sin(away + offset));
            let at = [pos[0] + x * 90.0, pos[1] + y * 90.0];
            let score = distance(at, hunter) + (x * dx + y * dy) / length * 15.0
                - if at[0] < ctx.wall() + 100.0 {
                    1000.0
                } else {
                    0.0
                };
            if score > best
                && occupy(collision, gates, at, 12.0, false)
                && reach_clear_with_gates(
                    ctx.view.sight,
                    ctx.view.sight_gates,
                    (pos[0], pos[1]),
                    (at[0], at[1]),
                    |i| ctx.gate_open(i),
                )
                .0
            {
                best = score;
                motion = Some([x * 9.0, y * 9.0]);
            }
        }
        if let Some([x, y]) = motion {
            (dx, dy) = (x, y);
        }
    }
    let next = bot.detour.waypoint(
        ctx,
        collision.as_ref(),
        id,
        index,
        dynamic::Waypoint {
            pos,
            destination: [pos[0] + dx, pos[1] + dy],
            route_generation: bot.route.generation,
        },
        detour_edges,
    );
    (dx, dy) = (next[0] - pos[0], next[1] - pos[1]);
    if contestant
        && equipment
            .cell
            .is_some_and(|charge| charge < ctx.rules.interactions.charge_ticks)
        && ctx.view.state.stations.values().any(|s| {
            s.kind == StationKind::Charging
                && distance(pos, s.position) < 55.0
                && ctx.line(pos, s.position)
        })
    {
        input.interact = true;
        return input;
    }
    if contestant {
        input.reload = equipment.reload(ctx, actor, nearest.is_none());
    }
    input.transit = transit;
    let length = hypot(dx, dy).max(9.0);
    input.movement = [dx / length, dy / length];
    input.aim = Some(match nearest {
        Some((_, at, _)) => atan2(at[1] - pos[1], at[0] - pos[0]),
        None if dx == 0.0 && dy == 0.0 => actor.aim,
        None => atan2(dy, dx),
    });
    if let Some((enemy, at, d)) = nearest {
        let ally_in_line = contestant
            && ctx.settings.roster.iter().any(|&(other, ..)| {
                if other == id
                    || other == enemy
                    || other.kind != ActorKind::Contestant
                    || ctx.view.state.actors[&other].presence != Presence::Active
                {
                    return false;
                }
                let Some(other) = ctx.point(other) else {
                    return false;
                };
                let (nx, ny) = (at[0] - pos[0], at[1] - pos[1]);
                let t = ((other[0] - pos[0]) * nx + (other[1] - pos[1]) * ny) / (nx * nx + ny * ny);
                t > 0.0
                    && t < 1.0
                    && hypot(other[0] - pos[0] - t * nx, other[1] - pos[1] - t * ny) < 28.0
            });
        input.attack =
            !ally_in_line && d < if contestant { 450.0 } else { 86.0 } && ctx.line(pos, at);
        input.skill = d < if !contestant && actor.kit == Some(Kit::Specter) {
            320.0
        } else {
            125.0
        };
    }
    input.interact = contestant
        || pos[0] < ctx.wall() + 200.0
        || ctx
            .view
            .state
            .gates
            .values()
            .any(|g| !g.open && distance(pos, g.position) < 85.0);
    input
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossing_relabels_use_the_rank_after_each_binding() {
        let [a, b, c, d] = [0, 1, 2, 3].map(|seat| ActorId {
            kind: ActorKind::Contestant,
            seat,
        });
        let mut game = Scenario::default().start(1, 10);
        game.bots = Planner::new(
            Settings {
                roster: [a, b, c, d]
                    .into_iter()
                    .enumerate()
                    .map(|(rank, id)| (id, false, true, rank))
                    .collect(),
                ..Settings::default()
            },
            0.0,
            None,
            None,
        );
        let relabel = |actor, rank| {
            Inbound::Observation(Observation::Join {
                actor,
                kit: None,
                bot_label: Some((rank, true)),
            })
        };

        // [a, b, c, d] -> [b, c, a, d] -> [c, a, d, b].
        // Using a's final rank (1) for its observation would swap a and c.
        collect(
            &mut game,
            &Combat::default(),
            1,
            &[relabel(a, 2), relabel(b, 3)],
        );
        assert_eq!(game.bots.lexical, [c, a, d, b]);
        assert!(game.bots.settings.roster[0].1);
        assert!(game.bots.settings.roster[1].1);
    }
}
