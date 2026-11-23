use std::collections::{BTreeMap, BTreeSet};

use super::input::Carried;
use super::solve::{Bodies, BodySpec, Contact};
use super::state::{
    ActorId, BodyId, Deadlines, Entity, GroundItem, Hook, HookId, HookPhase, ItemId, Point,
    Presence, Projectile, ProjectileId, State, Status, Tick, Window,
};

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
    SetPresence { actor: ActorId, presence: Presence },
    RemoveItem(ItemId),
    RemoveProjectile(ProjectileId),
    RemoveHook(HookId),
    UpdateHook { id: HookId, hook: Hook },
    Warp { body: BodyId, to: Point, angle: f64 },
}

pub enum Spawn {
    Item {
        item: GroundItem,
        body: Option<BodySpec>,
    },
    Projectile(Projectile),
    Hook(Hook),
}

/// The source and its canonical local ordinal identify a placement, independently of where
/// the placement ranked in arbitration. Successful placements receive IDs in this order.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct SpawnKey {
    pub source: Entity,
    pub ordinal: u32,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Rejection {
    SkillCooldown,
    HookCapacity,
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

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Fact {
    Hit { source: Entity, target: ActorId },
    Rejected { actor: ActorId, reason: Rejection },
    Eliminated { actor: ActorId },
    Placed { source: Entity, placed: Entity },
    Boosted { actor: ActorId },
    HookFired { owner: ActorId },
    HookAttached { owner: ActorId, target: ActorId },
    HookReleased { owner: ActorId, reason: HookRelease },
    Contact(Contact),
    Finished,
}

impl Fact {
    fn source(self) -> Entity {
        match self {
            Self::Hit { source, .. } | Self::Placed { source, .. } => source,
            Self::Rejected { actor, .. } | Self::Eliminated { actor } | Self::Boosted { actor } => {
                Entity::Actor(actor)
            }
            Self::HookFired { owner }
            | Self::HookAttached { owner, .. }
            | Self::HookReleased { owner, .. } => Entity::Actor(owner),
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

pub(super) fn merge<C, P>(state: &mut State, effects: &mut Effects<C, P>) -> Vec<Elimination> {
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
        Self {
            item: state.items.last_key_value().map_or(0, |(id, _)| id.0),
            projectile: state.projectiles.last_key_value().map_or(0, |(id, _)| id.0),
            hook: state.hooks.last_key_value().map_or(0, |(id, _)| id.0),
            event: 0,
        }
    }

    pub(super) fn spawn(
        &mut self,
        state: &mut State,
        bodies: &mut Bodies,
        spawns: BTreeMap<SpawnKey, Spawn>,
        facts: &mut Vec<Fact>,
    ) {
        for (key, spawn) in spawns {
            let placed = match spawn {
                Spawn::Item { item, body } => {
                    let id = ItemId(next(&mut self.item));
                    if let Some(body) = body {
                        bodies.insert(BodyId::Item(id), body);
                    }
                    state.items.insert(id, item);
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
            Lifecycle::RemoveProjectile(id) => {
                state.projectiles.remove(&id);
            }
            Lifecycle::RemoveHook(id) => {
                state.hooks.remove(&id);
            }
            Lifecycle::UpdateHook { id, hook } => {
                if let Some(current) = state.hooks.get_mut(&id) {
                    *current = hook;
                }
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
