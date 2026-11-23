use std::collections::{BTreeMap, BTreeSet};

use super::input::{Carried, Inbound};
use super::inventory::Utility;
use super::solve::{Bodies, BodySpec, Contact};
use super::state::{
    ActorId, ActorKind, Aggression, BodyId, Deadlines, Entity, GroundItem, Hook, HookId, HookPhase,
    ItemId, Point, Presence, Projectile, ProjectileId, State, Status, Tick, Trap, TrapId,
    WeaponKind, Window,
};
use super::{AmmoFamily, actor_word, contest_score};
use super::{GateId, StationId, Target};

const KILL_CREDIT_CONTEST: u64 = 0x6b69_6c6c_0000_0000;
const AGGRESSION_CONTEST: u64 = 0x6167_6772_0000_0000;
const AGGRESSION_DURATION: Tick = 200;

#[derive(Clone, Copy, Debug)]
pub enum VitalEffect {
    Damage { source: Entity, amount: f64 },
    Heal(f64),
    Shield(f64),
}

#[derive(Clone, Copy, Debug)]
pub enum StatusEffect {
    Extend(Window),
    Clear,
}

#[derive(Clone, Copy, Debug)]
pub enum Lifecycle {
    SetPresence {
        actor: ActorId,
        presence: Presence,
    },
    RemoveItem(ItemId),
    SyncGate(GateId),
    RemoveProjectile(ProjectileId),
    UpdateProjectile {
        id: ProjectileId,
        projectile: Projectile,
    },
    RemoveHook(HookId),
    UpdateHook {
        id: HookId,
        hook: Hook,
    },
    UpdateTrap {
        id: TrapId,
        trap: Trap,
    },
    Warp {
        body: BodyId,
        to: Point,
        angle: f64,
    },
}

pub enum Spawn {
    Item {
        id: Option<ItemId>,
        item: GroundItem,
        body: Option<BodySpec>,
    },
    SplitItem {
        actor: ActorId,
        slot: usize,
    },
    Projectile(Projectile),
    Hook(Hook),
}

/// The source and its canonical local ordinal identify a placement, independently of where
/// the placement ranked in arbitration. Successful placements receive IDs in this order.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct SpawnKey {
    pub source: Entity,
    pub ordinal: u64,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Rejection {
    SkillCooldown,
    HookCapacity,
    Drop,
    DropAmmo(AmmoFamily),
    Reload,
    SelectSlot,
    MoveSlot,
    Pickup(ItemId),
    Swap(ItemId),
    Interaction(Option<Target>),
    GateLocked(GateId),
    GateOccupied(GateId),
    GateContested(GateId),
    Transit(StationId),
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum HookRelease {
    Cancelled,
    Expired,
    Obstructed,
    FriendlyContact,
    Range,
    Standoff,
    Separation,
    EndpointGone,
    Relocated,
}

/// Retain the exact solved pose in the event while keeping a total order for publication.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct EventPoint([u64; 2]);

impl From<Point> for EventPoint {
    fn from(position: Point) -> Self {
        Self(position.map(f64::to_bits))
    }
}

impl EventPoint {
    pub fn position(self) -> Point {
        self.0.map(f64::from_bits)
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Fact {
    Hit {
        source: Entity,
        target: ActorId,
    },
    Rejected {
        actor: ActorId,
        reason: Rejection,
    },
    Eliminated {
        actor: ActorId,
    },
    KillCredited {
        actor: ActorId,
        target: ActorId,
    },
    Assisted {
        actor: ActorId,
        target: ActorId,
    },
    KillRewarded {
        actor: ActorId,
    },
    Placed {
        source: Entity,
        placed: Entity,
    },
    Boosted {
        actor: ActorId,
    },
    ShotFired {
        actor: ActorId,
        weapon: WeaponKind,
    },
    ReloadStarted {
        actor: ActorId,
        ready_at: Tick,
    },
    Reloaded {
        actor: ActorId,
        weapon: WeaponKind,
        rounds: u32,
    },
    Pickup {
        actor: ActorId,
        item: ItemId,
        count: u32,
    },
    Escaped {
        actor: ActorId,
        cell: ItemId,
    },
    ChargingStarted {
        actor: ActorId,
        station: StationId,
    },
    ChargingStopped {
        actor: ActorId,
        station: StationId,
    },
    CellCharged {
        actor: ActorId,
        station: StationId,
    },
    GateChanged {
        actor: ActorId,
        gate: GateId,
        open: bool,
    },
    GateObserved {
        actor: ActorId,
        gate: GateId,
        open: bool,
        locked: bool,
    },
    TransitDeparted {
        actor: ActorId,
        destination: StationId,
    },
    TransitLanded {
        actor: ActorId,
        destination: StationId,
    },
    UtilityUsed {
        actor: ActorId,
        utility: Utility,
    },
    MeleeSwung {
        actor: ActorId,
    },
    WardenPulsed {
        actor: ActorId,
    },
    SpecterScanned {
        actor: ActorId,
    },
    HookFired {
        owner: ActorId,
    },
    HookAttached {
        owner: ActorId,
        target: ActorId,
    },
    HookReleased {
        owner: ActorId,
        reason: HookRelease,
    },
    MineExploded {
        trap: TrapId,
    },
    SpiderGrappled {
        trap: TrapId,
        target: ActorId,
        at: EventPoint,
    },
    Contact(Contact),
    Finished,
}

impl Fact {
    fn source(self) -> Entity {
        match self {
            Self::Hit { source, .. } | Self::Placed { source, .. } => source,
            Self::Rejected { actor, .. }
            | Self::Eliminated { actor }
            | Self::KillCredited { actor, .. }
            | Self::Assisted { actor, .. }
            | Self::KillRewarded { actor }
            | Self::Boosted { actor }
            | Self::ShotFired { actor, .. }
            | Self::ReloadStarted { actor, .. }
            | Self::Reloaded { actor, .. }
            | Self::Pickup { actor, .. }
            | Self::Escaped { actor, .. }
            | Self::ChargingStarted { actor, .. }
            | Self::ChargingStopped { actor, .. }
            | Self::CellCharged { actor, .. }
            | Self::GateChanged { actor, .. }
            | Self::GateObserved { actor, .. }
            | Self::TransitDeparted { actor, .. }
            | Self::TransitLanded { actor, .. }
            | Self::UtilityUsed { actor, .. }
            | Self::MeleeSwung { actor }
            | Self::WardenPulsed { actor }
            | Self::SpecterScanned { actor } => Entity::Actor(actor),
            Self::HookFired { owner }
            | Self::HookAttached { owner, .. }
            | Self::HookReleased { owner, .. } => Entity::Actor(owner),
            Self::MineExploded { trap } | Self::SpiderGrappled { trap, .. } => Entity::Trap(trap),
            Self::Contact(contact) => Entity::from(contact.a),
            Self::Finished => Entity::Match,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Event {
    pub id: u64,
    pub tick: Tick,
    pub fact: Fact,
}

/// Data emitted by resolve. Claims and placement requests retain their mechanic's typed
/// payload. Apply commits them in separate stages using the corresponding rule.
pub struct Effects<C, P> {
    pub vitals: Vec<(ActorId, VitalEffect)>,
    pub statuses: Vec<(ActorId, Status, StatusEffect)>,
    pub impulses: Vec<(BodyId, Point)>,
    pub claims: Vec<(ActorId, C)>,
    pub placements: Vec<P>,
    pub new_hooks: BTreeMap<ActorId, Hook>,
    pub new_projectiles: BTreeMap<SpawnKey, Projectile>,
    pub lifecycle: Vec<Lifecycle>,
    pub facts: Vec<Fact>,
}

impl<C, P> Default for Effects<C, P> {
    fn default() -> Self {
        Self {
            vitals: Vec::new(),
            statuses: Vec::new(),
            impulses: Vec::new(),
            claims: Vec::new(),
            placements: Vec::new(),
            new_hooks: BTreeMap::new(),
            new_projectiles: BTreeMap::new(),
            lifecycle: Vec::new(),
            facts: Vec::new(),
        }
    }
}

#[derive(Default)]
pub struct Commit {
    pub lifecycle: Vec<Lifecycle>,
    pub deadlines: BTreeMap<ActorId, Deadlines>,
    pub carried: Vec<Carried>,
    pub facts: Vec<Fact>,
    pub(super) charging: super::interaction::ChargeChanges,
}

#[derive(Debug)]
pub struct Elimination {
    pub actor: ActorId,
    pub hitters: BTreeSet<Entity>,
}

#[derive(Default)]
struct Vitals {
    heal: Vec<f64>,
    shield: Vec<f64>,
    damage: Vec<f64>,
    hitters: BTreeSet<Entity>,
}

fn sum(mut amounts: Vec<f64>) -> f64 {
    amounts.sort_unstable_by(f64::total_cmp);
    amounts.into_iter().sum()
}

pub(super) fn merge<C, P>(
    state: &mut State,
    seed: u64,
    tick: Tick,
    effects: &mut Effects<C, P>,
) -> Vec<Elimination> {
    let mut vitals = BTreeMap::<ActorId, Vitals>::new();
    for (target, effect) in effects.vitals.drain(..) {
        if !state.active(target) {
            continue;
        }
        let target = vitals.entry(target).or_default();
        match effect {
            VitalEffect::Heal(n) => target.heal.push(n),
            VitalEffect::Shield(n) => target.shield.push(n),
            VitalEffect::Damage { source, amount } => {
                target.damage.push(amount);
                if amount > 0.0 {
                    target.hitters.insert(source);
                }
            }
        }
    }
    let mut eliminated = Vec::new();
    for (id, delta) in vitals {
        let actor = state.actors.get_mut(&id).expect("active actor");
        let damage = sum(delta.damage);
        let shield = (actor.shield + sum(delta.shield)).min(actor.max_shield);
        let hp = (actor.hp + sum(delta.heal)).min(actor.max_hp);
        actor.shield = (shield - damage).max(0.0);
        actor.hp = (hp - (damage - shield).max(0.0)).max(0.0);
        if let Some(source) = ranked_hitter(seed, tick, AGGRESSION_CONTEST, id, &delta.hitters) {
            actor.aggression = Some(Aggression {
                source,
                expires_at: tick.saturating_add(AGGRESSION_DURATION),
            });
        }
        if actor.hp == 0.0 {
            eliminated.push(Elimination {
                actor: id,
                hitters: delta.hitters,
            });
        }
    }

    let mut statuses = BTreeMap::<(ActorId, Status), Option<Window>>::new();
    for (actor, kind, edit) in effects.statuses.drain(..) {
        if !state.active(actor) {
            continue;
        }
        let initial = state.actors[&actor].statuses.get(&kind).copied();
        match edit {
            StatusEffect::Clear => {
                statuses.insert((actor, kind), None);
            }
            StatusEffect::Extend(window) => {
                statuses
                    .entry((actor, kind))
                    .and_modify(|resolved| {
                        if let Some(current) = resolved {
                            *current = later(*current, window);
                        }
                    })
                    .or_insert_with(|| {
                        Some(initial.map_or(window, |current| later(current, window)))
                    });
            }
        }
    }
    for ((actor, kind), window) in statuses {
        let current = &mut state.actors.get_mut(&actor).expect("active actor").statuses;
        if let Some(window) = window {
            current.insert(kind, window);
        } else {
            current.remove(&kind);
        }
    }
    eliminated
}

fn actor_hitter(source: Entity, target: ActorId) -> Option<ActorId> {
    match source {
        Entity::Actor(actor) if actor != target => Some(actor),
        _ => None,
    }
}

fn ranked_hitter(
    seed: u64,
    tick: Tick,
    contest: u64,
    target: ActorId,
    hitters: &BTreeSet<Entity>,
) -> Option<ActorId> {
    hitters
        .iter()
        .filter_map(|&source| actor_hitter(source, target))
        .min_by_key(|&actor| {
            (
                contest_score(seed, tick, contest ^ actor_word(target), actor_word(actor)),
                actor,
            )
        })
}

pub(super) fn credit_eliminations(
    state: &mut State,
    seed: u64,
    tick: Tick,
    deaths: &[Elimination],
    commit: &mut Commit,
) {
    for death in deaths {
        let target = death.actor;
        let Some(actor) = ranked_hitter(seed, tick, KILL_CREDIT_CONTEST, target, &death.hitters)
        else {
            continue;
        };
        if let Some(record) = state.actors.get_mut(&actor) {
            record.kills = record.kills.saturating_add(1);
        }
        commit.facts.push(Fact::KillCredited { actor, target });
        if actor.kind == ActorKind::Gladiator {
            commit.carried.push(Carried::KillReward { actor });
        }
        commit
            .facts
            .extend(death.hitters.iter().filter_map(|&source| {
                let helper = actor_hitter(source, target)?;
                (helper != actor).then_some(Fact::Assisted {
                    actor: helper,
                    target,
                })
            }));
    }
}

pub(super) fn reward_kills(state: &mut State, inbound: &[Inbound], facts: &mut Vec<Fact>) {
    for entry in inbound {
        let Inbound::Carried(Carried::KillReward { actor }) = *entry else {
            continue;
        };
        if let Some(record) = state.actors.get_mut(&actor) {
            record.level = record.level.saturating_add(1).min(4);
            record.max_hp += 20.0;
            record.hp = (record.hp + 45.0).min(record.max_hp);
            record.deadlines.skill_ready_at = 0;
            facts.push(Fact::KillRewarded { actor });
        }
    }
}

fn later(a: Window, b: Window) -> Window {
    // Choose the latest expiry and then the earliest start for equal expiries.
    if a.expires_at > b.expires_at
        || (a.expires_at == b.expires_at && a.active_from < b.active_from)
    {
        a
    } else {
        b
    }
}

pub(super) fn impulses(
    pushes: impl IntoIterator<Item = (BodyId, Point)>,
) -> BTreeMap<BodyId, Point> {
    let mut by_body = BTreeMap::<BodyId, [Vec<f64>; 2]>::new();
    for (body, [x, y]) in pushes {
        let [xs, ys] = by_body.entry(body).or_default();
        xs.push(x);
        ys.push(y);
    }
    by_body
        .into_iter()
        .map(|(body, axes)| (body, axes.map(sum)))
        .collect()
}

#[derive(Default)]
pub(super) struct Ids {
    item: u32,
    projectile: u32,
    hook: u32,
    event: u64,
}

impl Ids {
    pub(super) fn from_state(state: &State) -> Self {
        let ground = state
            .items
            .iter()
            .flat_map(|(&id, item)| [id, item.lineage.unwrap_or(id)]);
        let held = state.actors.values().flat_map(|actor| {
            actor
                .inventory
                .slots
                .iter()
                .flatten()
                .flat_map(|item| [item.id, item.lineage])
        });
        Self {
            item: ground.chain(held).map(|id| id.0).max().unwrap_or(0),
            projectile: state.projectiles.last_key_value().map_or(0, |(id, _)| id.0),
            hook: state.hooks.last_key_value().map_or(0, |(id, _)| id.0),
            event: 0,
        }
    }

    pub(super) fn spawn(
        &mut self,
        state: &mut State,
        bodies: &mut Bodies,
        spawns: impl IntoIterator<Item = (SpawnKey, Spawn)>,
        facts: &mut Vec<Fact>,
    ) {
        for (key, spawn) in spawns {
            let placed = match spawn {
                Spawn::SplitItem { actor, slot } => {
                    let item = state
                        .actors
                        .get_mut(&actor)
                        .expect("pickup winner")
                        .inventory
                        .slots[slot]
                        .as_mut()
                        .expect("split pickup");
                    item.id = ItemId(next(&mut self.item));
                    continue;
                }
                Spawn::Item { id, item, body } => {
                    let id = id.unwrap_or_else(|| ItemId(next(&mut self.item)));
                    if let Some(body) = body {
                        bodies.insert(BodyId::Item(id), body);
                    }
                    assert!(
                        state.items.insert(id, item).is_none(),
                        "item identity already on ground"
                    );
                    Entity::Item(id)
                }
                Spawn::Projectile(projectile) => {
                    let id = ProjectileId(next(&mut self.projectile));
                    state.projectiles.insert(id, projectile);
                    Entity::Projectile(id)
                }
                Spawn::Hook(hook) => {
                    let id = HookId(next(&mut self.hook));
                    state.hooks.insert(id, hook);
                    Entity::Hook(id)
                }
            };
            facts.push(Fact::Placed {
                source: key.source,
                placed,
            });
        }
    }

    pub(super) fn publish(&mut self, tick: Tick, mut facts: Vec<Fact>) -> Vec<Event> {
        facts.sort_unstable_by_key(|&fact| (fact.source(), fact));
        facts
            .into_iter()
            .map(|fact| {
                self.event = self.event.checked_add(1).expect("event IDs exhausted");
                Event {
                    id: self.event,
                    tick,
                    fact,
                }
            })
            .collect()
    }
}

fn next(id: &mut u32) -> u32 {
    *id = id.checked_add(1).expect("entity IDs exhausted");
    *id
}

pub(super) fn sync(
    state: &mut State,
    bodies: &mut Bodies,
    lifecycle: Vec<Lifecycle>,
    deaths: &[Elimination],
    facts: &mut Vec<Fact>,
) -> BTreeSet<ActorId> {
    let mut presence_changes = BTreeMap::new();
    let mut warps = BTreeMap::new();
    let mut removed = BTreeSet::new();
    for effect in lifecycle {
        match effect {
            Lifecycle::SetPresence { actor, presence } => {
                let old = presence_changes.insert(actor, presence);
                assert!(
                    old.is_none_or(|old| old == presence),
                    "unresolved presence changes"
                );
            }
            Lifecycle::RemoveItem(id) => {
                state.items.remove(&id);
                removed.insert(BodyId::Item(id));
            }
            Lifecycle::SyncGate(id) => bodies.sync_gate(id, state.gates[&id].open),
            Lifecycle::RemoveProjectile(id) => {
                state.projectiles.remove(&id);
            }
            Lifecycle::UpdateProjectile { id, projectile } => {
                if let Some(current) = state.projectiles.get_mut(&id) {
                    *current = projectile;
                }
            }
            Lifecycle::RemoveHook(id) => {
                state.hooks.remove(&id);
            }
            Lifecycle::UpdateHook { id, hook } => {
                if let Some(current) = state.hooks.get_mut(&id) {
                    *current = hook;
                }
            }
            Lifecycle::UpdateTrap { id, trap } => {
                *state.traps.get_mut(&id).expect("resolved trap") = trap;
            }
            Lifecycle::Warp { body, to, angle } => {
                let old = warps.insert(body, (to, angle));
                assert!(old.is_none_or(|old| old == (to, angle)), "unresolved warps");
            }
        }
    }
    // A removal settled by the elimination stage overrides other lifecycle requests.
    for death in deaths {
        presence_changes.insert(death.actor, Presence::Eliminated);
    }
    let mut deactivated = BTreeSet::new();
    for (actor, presence) in presence_changes {
        if let Some(record) = state.actors.get_mut(&actor) {
            record.presence = presence;
            if presence != Presence::Active {
                record.inventory.reload = None;
                record.charging = None;
                deactivated.insert(actor);
                removed.insert(BodyId::Actor(actor));
            }
        }
    }
    for &id in &removed {
        bodies.remove(id);
    }
    for (&id, &(to, angle)) in &warps {
        if !removed.contains(&id) {
            bodies.warp(id, to, angle);
        }
    }
    let actors = &state.actors;
    state.hooks.retain(|_, hook| {
        let target = match hook.phase {
            HookPhase::Flying { .. } => None,
            HookPhase::Pulling { target, .. } => Some(target),
        };
        let active = |id| {
            actors
                .get(&id)
                .is_some_and(|actor| actor.presence == Presence::Active)
        };
        let warped = |id| warps.contains_key(&BodyId::Actor(id));
        let reason = if !active(hook.owner) || target.is_some_and(|target| !active(target)) {
            HookRelease::EndpointGone
        } else if warped(hook.owner) || target.is_some_and(warped) {
            HookRelease::Relocated
        } else {
            return true;
        };
        facts.push(Fact::HookReleased {
            owner: hook.owner,
            reason,
        });
        false
    });
    deactivated
}
