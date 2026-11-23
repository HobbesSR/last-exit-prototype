//! Fire and casts write spends in intake, then resolve against S0 and solved paths.

use crate::math::{atan2, cos, hypot, sin};

use super::*;

const MELEE_CONTEST: u64 = 0x6d65_6c65_0000_0000;
const MELEE_REACH: f64 = 86.0;
const MELEE_ARC_COSINE: f64 = 0.25;
const MELEE_COOLDOWN: Tick = 13;
const WARDEN_REACH: f64 = 130.0;
const WARDEN_STUN: Tick = 22;
const SPECTER_REACH: f64 = 450.0;
const SPECTER_REVEAL: Tick = 110;

#[derive(Clone, Debug)]
pub struct WeaponTuning {
    pub damage: f64,
    pub speed: f64,
    pub life: Tick,
    pub cooldown: Tick,
    pub spread: Vec<f64>,
}

pub struct CombatRules {
    /// Indexed in `WeaponKind` order.
    pub weapons: [WeaponTuning; 3],
    /// Warden, Specter, Striker and Hook, in `Kit` order.
    pub melee_damage: [f64; 4],
    pub warden_cooldown: Tick,
    pub specter_cooldown: Tick,
}

impl Default for CombatRules {
    fn default() -> Self {
        Self {
            weapons: [
                WeaponTuning {
                    damage: 10.0,
                    speed: 35.0,
                    life: 24,
                    cooldown: 8,
                    spread: vec![0.0],
                },
                WeaponTuning {
                    damage: 6.0,
                    speed: 44.0,
                    life: 28,
                    cooldown: 4,
                    spread: vec![0.0],
                },
                WeaponTuning {
                    damage: 7.0,
                    speed: 30.0,
                    life: 12,
                    cooldown: 18,
                    spread: vec![-0.18, -0.09, 0.0, 0.09, 0.18],
                },
            ],
            melee_damage: [24.0, 19.0, 29.0, 24.0],
            warden_cooldown: 110,
            specter_cooldown: 150,
        }
    }
}

/// The staged tick's movement, combat, inventory, interaction and hazard rules.
#[derive(Default)]
pub struct Combat {
    pub movement: Movement,
    pub rules: CombatRules,
    pub items: ItemRules,
    pub interactions: InteractionRules,
    pub hazards: HazardRules,
}

#[derive(Clone, Copy, Debug)]
pub enum CombatIntent {
    Movement(MovementIntent),
    Items(ItemIntent),
    Interaction(ActorId, InteractionIntent),
    Fire(ActorId, WeaponKind),
    Melee(ActorId, Kit),
    Warden(ActorId),
    Specter(ActorId),
}

impl Combat {
    pub fn prepare(
        &self,
        view: &IntakeView<'_>,
        commands: &[Command],
        writes: &mut Intake,
    ) -> Vec<CombatIntent> {
        let mut intents: Vec<_> = self
            .movement
            .prepare(view, commands, writes)
            .into_iter()
            .map(CombatIntent::Movement)
            .collect();
        let (items, attacks) = self.items.prepare(view, commands, writes);
        intents.extend(items.into_iter().map(CombatIntent::Items));
        let tick = view.start.tick;
        for command in commands {
            let id = command.actor;
            let actor = &view.start.state.actors[&id];
            if let Some(interaction) = InteractionIntent::from_input(command.input) {
                intents.push(CombatIntent::Interaction(id, interaction));
            }
            let Some(position) = view.bodies.position(BodyId::Actor(id)) else {
                continue;
            };
            if id.kind == ActorKind::Gladiator {
                if command.input.skill {
                    intents.extend(self.prepare_skill(command, actor, writes));
                }
                if command.input.attack
                    && tick >= actor.deadlines.weapon_ready_at
                    && let Some(kit) = actor.kit
                {
                    writes
                        .weapon_ready_at
                        .insert(id, tick.saturating_add(MELEE_COOLDOWN));
                    intents.push(CombatIntent::Melee(id, kit));
                }
            } else if attacks.contains(&id) {
                intents.extend(self.prepare_fire(command, actor, position, writes));
            }
        }
        intents
    }

    fn prepare_skill(
        &self,
        command: &Command,
        actor: &Actor,
        writes: &mut Intake,
    ) -> Option<CombatIntent> {
        let id = command.actor;
        let (cooldown, intent) = match actor.kit {
            Some(Kit::Warden) => (self.rules.warden_cooldown, CombatIntent::Warden(id)),
            Some(Kit::Specter) => (self.rules.specter_cooldown, CombatIntent::Specter(id)),
            _ => return None,
        };
        let tick = command.tick;
        if tick < actor.deadlines.skill_ready_at {
            writes.facts.push(Fact::Rejected {
                actor: id,
                reason: Rejection::SkillCooldown,
            });
            return None;
        }
        let reduction = 12 * Tick::from(actor.level.saturating_sub(1));
        let cooldown = cooldown.saturating_sub(reduction).max(45);
        writes
            .skill_ready_at
            .insert(id, tick.saturating_add(cooldown));
        Some(intent)
    }

    fn prepare_fire(
        &self,
        command: &Command,
        actor: &Actor,
        position: Point,
        writes: &mut Intake,
    ) -> Option<CombatIntent> {
        let input = command.input;
        let tick = command.tick;
        let id = command.actor;
        let inventory = writes.inventories.get(&id).unwrap_or(&actor.inventory);
        let (kind, rounds, quality) = inventory.selected_weapon()?;
        if rounds == 0 {
            return None;
        }
        let multiplier = if self.items.quality_damage {
            [1.0, 1.08, 1.16, 1.24, 1.32][usize::from(quality.clamp(1, 5) - 1)]
        } else {
            1.0
        };
        let weapon = &self.rules.weapons[kind as usize];
        let aim = input.aim.unwrap_or(actor.aim);
        writes
            .inventories
            .entry(id)
            .or_insert(actor.inventory)
            .spend_round();
        writes
            .weapon_ready_at
            .insert(id, tick.saturating_add(weapon.cooldown));
        for (ordinal, spread) in weapon.spread.iter().enumerate() {
            let angle = aim + spread;
            let projectile = Projectile {
                source: Entity::Actor(id),
                position,
                velocity: [cos(angle) * weapon.speed, sin(angle) * weapon.speed],
                damage: weapon.damage * multiplier,
                active_from: tick,
                expires_at: tick.saturating_add(weapon.life.saturating_sub(1)),
            };
            writes.projectiles.insert((id, ordinal as u32), projectile);
        }
        Some(CombatIntent::Fire(id, kind))
    }

    pub fn resolve_into(
        &self,
        view: &ResolveView<'_>,
        intents: &[CombatIntent],
        effects: &mut Effects<InteractionClaim, DropRequest>,
    ) {
        let movement = intents.iter().filter_map(|intent| match *intent {
            CombatIntent::Movement(movement) => Some(movement),
            _ => None,
        });
        self.movement.resolve_into(view, movement, effects);
        self.items.resolve_into(
            view,
            intents.iter().filter_map(|intent| match *intent {
                CombatIntent::Items(item) => Some(item),
                _ => None,
            }),
            effects,
        );
        self.interactions.resolve_into(
            view,
            intents.iter().filter_map(|intent| match *intent {
                CombatIntent::Interaction(actor, interaction) => Some((actor, interaction)),
                _ => None,
            }),
            &self.items,
            effects,
        );
        projectile::resolve_into(view, effects);
        self.hazards.resolve_into(view, effects);
        for intent in intents {
            match *intent {
                CombatIntent::Movement(_)
                | CombatIntent::Items(_)
                | CombatIntent::Interaction(..) => {}
                CombatIntent::Fire(actor, weapon) => {
                    effects.facts.push(Fact::ShotFired { actor, weapon });
                    effects
                        .statuses
                        .push((actor, Status::Cloak, StatusEffect::Clear));
                }
                CombatIntent::Melee(actor, kit) => self.melee(view, effects, actor, kit),
                CombatIntent::Warden(actor) => warden(view, effects, actor),
                CombatIntent::Specter(actor) => specter(view, effects, actor),
            }
        }
    }

    fn melee<C, P>(
        &self,
        view: &ResolveView<'_>,
        effects: &mut Effects<C, P>,
        caster: ActorId,
        kit: Kit,
    ) {
        let Some(origin) = view.solved.position(BodyId::Actor(caster)) else {
            return;
        };
        effects.facts.push(Fact::MeleeSwung { actor: caster });
        let actor = &view.start.state.actors[&caster];
        let rewind = view.rewound(caster);
        let contest = MELEE_CONTEST ^ actor_word(caster);
        let target = opponents(view, caster)
            .filter_map(|target| {
                let position = rewind.position(target)?;
                let [dx, dy] = [position[0] - origin[0], position[1] - origin[1]];
                let distance = hypot(dx, dy);
                let eligible = distance < MELEE_REACH
                    && cos(atan2(dy, dx) - actor.aim) > MELEE_ARC_COSINE
                    && rewind.line_clear(origin, position);
                if !eligible {
                    return None;
                }
                let current = view.solved.position(BodyId::Actor(target))?;
                Some((
                    target,
                    hypot(current[0] - origin[0], current[1] - origin[1]),
                ))
            })
            .min_by(|&(a, da), &(b, db)| {
                let rank = |target| {
                    (
                        contest_score(
                            view.start.seed,
                            view.start.tick,
                            contest,
                            actor_word(target),
                        ),
                        target,
                    )
                };
                da.total_cmp(&db).then_with(|| rank(a).cmp(&rank(b)))
            });
        if let Some((target, _)) = target {
            let damage = self.rules.melee_damage[kit as usize]
                + 4.0 * f64::from(actor.level.saturating_sub(1));
            hit(effects, Entity::Actor(caster), target, damage);
        }
    }
}

fn opponents<'a>(view: &'a ResolveView<'_>, caster: ActorId) -> impl Iterator<Item = ActorId> + 'a {
    view.start
        .state
        .actors
        .iter()
        .filter_map(move |(&id, actor)| {
            (id.kind != caster.kind && actor.presence == Presence::Active).then_some(id)
        })
}

fn warden<C, P>(view: &ResolveView<'_>, effects: &mut Effects<C, P>, caster: ActorId) {
    let Some(origin) = view.solved.position(BodyId::Actor(caster)) else {
        return;
    };
    effects.facts.push(Fact::WardenPulsed { actor: caster });
    let rewind = view.rewound(caster);
    let damage = 18.0 + 5.0 * f64::from(view.start.state.actors[&caster].level);
    for target in opponents(view, caster) {
        if let Some(position) = rewind.position(target)
            && hypot(position[0] - origin[0], position[1] - origin[1]) < WARDEN_REACH
            && rewind.line_clear(origin, position)
        {
            hit(effects, Entity::Actor(caster), target, damage);
            extend(effects, target, Status::Stun, view.start.tick, WARDEN_STUN);
        }
    }
}

fn specter<C, P>(view: &ResolveView<'_>, effects: &mut Effects<C, P>, caster: ActorId) {
    let Some(origin) = view.solved.position(BodyId::Actor(caster)) else {
        return;
    };
    effects.facts.push(Fact::SpecterScanned { actor: caster });
    for target in opponents(view, caster) {
        if let Some(position) = view.solved.position(BodyId::Actor(target))
            && hypot(position[0] - origin[0], position[1] - origin[1]) < SPECTER_REACH
        {
            extend(
                effects,
                target,
                Status::Reveal,
                view.start.tick,
                SPECTER_REVEAL,
            );
        }
    }
}

pub(super) fn extend<C, P>(
    effects: &mut Effects<C, P>,
    target: ActorId,
    kind: Status,
    tick: Tick,
    duration: Tick,
) {
    let active_from = tick.saturating_add(1);
    let window = Window {
        active_from,
        expires_at: active_from.saturating_add(duration),
    };
    effects
        .statuses
        .push((target, kind, StatusEffect::Extend(window)));
}

pub(super) fn hit<C, P>(effects: &mut Effects<C, P>, source: Entity, target: ActorId, amount: f64) {
    effects.facts.push(Fact::Hit { source, target });
    effects
        .vitals
        .push((target, VitalEffect::Damage { source, amount }));
}

impl Mechanics for Combat {
    type Intent = CombatIntent;
    type Claim = InteractionClaim;
    type Placement = DropRequest;

    fn intake(
        &self,
        view: IntakeView<'_>,
        inbound: &[Inbound],
        commands: &[Command],
        writes: &mut Intake,
    ) -> Vec<Self::Intent> {
        for entry in inbound {
            if let Inbound::Carried(Carried::GateObserved {
                actor,
                gate,
                open,
                locked,
            }) = *entry
            {
                writes.facts.push(Fact::GateObserved {
                    actor,
                    gate,
                    open,
                    locked,
                });
            }
        }
        self.prepare(&view, commands, writes)
    }

    fn resolve(
        &self,
        view: ResolveView<'_>,
        intents: &[Self::Intent],
    ) -> Effects<Self::Claim, Self::Placement> {
        let mut effects = Effects::default();
        self.resolve_into(&view, intents, &mut effects);
        effects
    }

    fn eliminations(
        &self,
        state: View<'_>,
        deaths: &[Elimination],
        placements: &mut Vec<Self::Placement>,
        _commit: &mut Commit,
    ) {
        self.items.deaths(state, deaths, placements);
    }

    fn claims(
        &self,
        state: &mut State,
        view: ClaimView<'_>,
        claims: Vec<(ActorId, Self::Claim)>,
        placement: &mut Placement<Self::Placement>,
        commit: &mut Commit,
    ) {
        commit.charging =
            self.interactions
                .settle(state, view, claims, &self.items, placement, commit);
    }

    fn place(
        &self,
        state: &mut State,
        view: ClaimView<'_>,
        placement: Placement<Self::Placement>,
        commit: &mut Commit,
    ) -> BTreeMap<SpawnKey, Spawn> {
        let spawns = self.items.place_drops(state, view, placement, commit);
        let charging = std::mem::take(&mut commit.charging);
        self.interactions.charge(state, charging, commit);
        spawns
    }
}
