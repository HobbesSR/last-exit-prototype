use std::collections::BTreeMap;

pub type Tick = u32;
pub type Point = [f64; 2];

macro_rules! ids {
    ($($name:ident),+ $(,)?) => {
        $(
            #[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
            pub struct $name(pub u32);
        )+
    };
}

ids!(ItemId, ProjectileId, HookId, GateId, TrapId, StationId);

/// The order of these variants is the actor-kind order in 27.2 A6.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ActorKind {
    Contestant,
    Gladiator,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ActorId {
    pub kind: ActorKind,
    pub seat: u32,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum BodyId {
    Actor(ActorId),
    Item(ItemId),
    Prop(u32),
    Gate(GateId),
    Geometry(u32),
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Entity {
    Actor(ActorId),
    Item(ItemId),
    Projectile(ProjectileId),
    Hook(HookId),
    Gate(GateId),
    Trap(TrapId),
    Station(StationId),
    Match,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Presence {
    Pending,
    Active,
    Eliminated,
    Escaped,
    Transit,
    Stranded,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Status {
    Boost,
    Cloak,
    Reveal,
    Stun,
}

/// A status is effective in the half-open interval [active_from, expires_at).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Window {
    pub active_from: Tick,
    pub expires_at: Tick,
}

impl Window {
    pub fn contains(self, tick: Tick) -> bool {
        self.active_from <= tick && tick < self.expires_at
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Deadlines {
    pub skill_ready_at: Tick,
    pub weapon_ready_at: Tick,
    pub transit_ready_at: Tick,
}

#[derive(Clone, Debug)]
pub struct Actor {
    pub presence: Presence,
    pub hp: f64,
    pub max_hp: f64,
    pub shield: f64,
    pub max_shield: f64,
    pub aim: f64,
    pub deadlines: Deadlines,
    pub statuses: BTreeMap<Status, Window>,
}

#[derive(Clone, Debug)]
pub struct GroundItem {
    /// The fallback position while a body is awaiting admission.
    pub unplaced_at: Option<Point>,
    pub pickup_ready_at: Tick,
}

#[derive(Clone, Debug)]
pub struct Projectile {
    pub owner: Option<ActorId>,
    pub position: Point,
    pub velocity: Point,
    pub active_from: Tick,
    pub expires_at: Tick,
}

#[derive(Clone, Debug)]
pub enum HookEnd {
    Flying(ProjectileId),
    Anchored(Point),
    Attached(BodyId),
}

#[derive(Clone, Debug)]
pub struct Hook {
    pub owner: ActorId,
    pub end: HookEnd,
    pub expires_at: Tick,
}

#[derive(Clone, Debug)]
pub struct Gate {
    pub open: bool,
    pub locked: bool,
}

#[derive(Clone, Debug)]
pub struct Trap {
    pub ready_at: Tick,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StationKind {
    Charging,
    Transit,
}

/// Geometry belongs to the map and physics. These tables hold discrete match state.
#[derive(Default)]
pub struct State {
    pub actors: BTreeMap<ActorId, Actor>,
    pub items: BTreeMap<ItemId, GroundItem>,
    pub projectiles: BTreeMap<ProjectileId, Projectile>,
    pub hooks: BTreeMap<HookId, Hook>,
    pub gates: BTreeMap<GateId, Gate>,
    pub traps: BTreeMap<TrapId, Trap>,
    pub stations: BTreeMap<StationId, StationKind>,
}

impl State {
    pub fn active(&self, actor: ActorId) -> bool {
        self.actors
            .get(&actor)
            .is_some_and(|actor| actor.presence == Presence::Active)
    }
}
