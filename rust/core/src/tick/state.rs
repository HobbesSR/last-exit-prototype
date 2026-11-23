use std::collections::BTreeMap;

use super::inventory::{Inventory, Loot};

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
    Prop(u32),
    Geometry(u32),
    Match,
}

impl From<BodyId> for Entity {
    fn from(id: BodyId) -> Self {
        match id {
            BodyId::Actor(id) => Self::Actor(id),
            BodyId::Item(id) => Self::Item(id),
            BodyId::Prop(id) => Self::Prop(id),
            BodyId::Gate(id) => Self::Gate(id),
            BodyId::Geometry(id) => Self::Geometry(id),
        }
    }
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Deadlines {
    pub skill_ready_at: Tick,
    pub weapon_ready_at: Tick,
    pub transit_ready_at: Tick,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Actor {
    pub presence: Presence,
    pub kit: Option<Kit>,
    pub level: u8,
    pub kills: u32,
    pub hp: f64,
    pub max_hp: f64,
    pub shield: f64,
    pub max_shield: f64,
    pub aim: f64,
    pub sneak: bool,
    pub view_lag: Tick,
    pub inventory: Inventory,
    pub charging: Option<Charging>,
    pub respawn_at: Option<Tick>,
    pub transit: Option<Transit>,
    pub bot: bool,
    pub aggression: Option<Aggression>,
    pub deadlines: Deadlines,
    pub statuses: BTreeMap<Status, Window>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum WeaponKind {
    Pistol,
    Rifle,
    Scattergun,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Aggression {
    pub source: ActorId,
    pub expires_at: Tick,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kit {
    Warden,
    Specter,
    Striker,
    Hook,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GroundItem {
    pub loot: Loot,
    /// If absent, the ground item's own ID is the root.
    pub lineage: Option<ItemId>,
    /// The stored position while the item has no body.
    pub unplaced_at: Option<Point>,
    pub dropped_by: Option<ActorId>,
    pub pickup_ready_at: Tick,
}

impl GroundItem {
    pub(super) fn position(&self, body_position: Option<Point>) -> Option<Point> {
        body_position.or(self.unplaced_at)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Projectile {
    pub source: Entity,
    pub position: Point,
    pub velocity: Point,
    pub damage: f64,
    pub active_from: Tick,
    pub expires_at: Tick,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HookPhase {
    Flying {
        position: Point,
        direction: Point,
        travelled: f64,
    },
    Pulling {
        target: ActorId,
        length: f64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hook {
    pub owner: ActorId,
    pub phase: HookPhase,
    pub expires_at: Tick,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Gate {
    pub open: bool,
    pub locked: bool,
    pub door: bool,
    pub position: Point,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Trap {
    pub position: Point,
    pub heading: f64,
    pub ready_at: Tick,
    pub kind: TrapKind,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TrapKind {
    Mine {
        spent: bool,
    },
    Turret {
        aiming: bool,
    },
    Flame {
        offset: Tick,
        warning: bool,
        firing: bool,
    },
    Spider {
        home: Point,
        target: Option<ActorId>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StationKind {
    Charging,
    Transit,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Station {
    pub kind: StationKind,
    pub position: Point,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Extraction {
    pub position: Point,
    pub slots: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Charging {
    pub station: StationId,
    pub cell: ItemId,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transit {
    pub destination: StationId,
    pub origin: Point,
    pub arrive_at: Tick,
}

/// Geometry belongs to the map and physics. These tables hold discrete match state.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    pub actors: BTreeMap<ActorId, Actor>,
    pub items: BTreeMap<ItemId, GroundItem>,
    pub projectiles: BTreeMap<ProjectileId, Projectile>,
    pub hooks: BTreeMap<HookId, Hook>,
    pub gates: BTreeMap<GateId, Gate>,
    pub traps: BTreeMap<TrapId, Trap>,
    pub stations: BTreeMap<StationId, Station>,
    pub extraction: Option<Extraction>,
    pub sensors: Vec<Point>,
    /// The advancing wall's x, or none for a match without a wall.
    pub hazard_x: Option<f64>,
}

impl State {
    pub fn active(&self, actor: ActorId) -> bool {
        self.actors
            .get(&actor)
            .is_some_and(|actor| actor.presence == Presence::Active)
    }
}
