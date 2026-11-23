use std::collections::BTreeMap;

use super::state::{ActorId, BodyId, GateId, ItemId, Point, StationId, Tick};

const REPEAT_TICKS: Tick = 10;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Target {
    Extraction,
    Station(StationId),
    Gate(GateId),
    Item(ItemId),
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum AmmoFamily {
    Pistol,
    Rifle,
    Shell,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DropSlot {
    Selected,
    Slot(u8),
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Input {
    pub movement: Point,
    pub aim: Option<f64>,
    pub sneak: bool,
    pub attack: bool,
    pub utility_slot: Option<u8>,
    pub skill: bool,
    pub interact: bool,
    pub target: Option<Target>,
    pub slot: Option<u8>,
    pub move_slot: Option<(u8, u8)>,
    pub drop: Option<DropSlot>,
    pub reload: bool,
    pub drop_ammo: Option<(AmmoFamily, u32)>,
    pub transit: Option<StationId>,
}

impl Input {
    pub(super) fn held(self) -> Self {
        Self {
            movement: self.movement,
            aim: self.aim,
            sneak: self.sneak,
            ..Self::default()
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandSource {
    Player,
    Bot,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Command {
    pub actor: ActorId,
    pub source: CommandSource,
    pub tick: Tick,
    pub seq: u64,
    pub input: Input,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Observation {
    ViewLag { actor: ActorId, ticks: Tick },
    InputLead { actor: ActorId, ticks: Tick },
    Join { actor: ActorId },
    Leave { actor: ActorId },
    Teleport { body: BodyId, to: Point },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Carried {
    Impulse {
        body: BodyId,
        impulse: Point,
    },
    KillReward {
        actor: ActorId,
    },
    GateObserved {
        actor: ActorId,
        gate: GateId,
        open: bool,
        locked: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Inbound {
    Command(Command),
    Observation(Observation),
    Carried(Carried),
}

/// Receive-side lead and sequence admission stays at the boundary. This spends at most
/// one stamped command per active actor and exposes only spent sequences for acknowledgment.
#[derive(Default)]
pub(super) struct InputState {
    acknowledged: BTreeMap<ActorId, u64>,
    held: BTreeMap<ActorId, Command>,
}

impl InputState {
    pub(super) fn spend(&mut self, command: Command) {
        self.acknowledged.insert(command.actor, command.seq);
        self.held.insert(command.actor, command);
    }

    /// A seat changing hands (join or leave) starts its input over: nothing held, and nothing
    /// spent, since a resumed connection numbers its commands from the start again.
    pub(super) fn reset(&mut self, actor: ActorId) {
        self.held.remove(&actor);
        self.acknowledged.remove(&actor);
    }

    pub(super) fn acknowledged(&self, actor: ActorId) -> Option<u64> {
        self.acknowledged.get(&actor).copied()
    }

    pub(super) fn held(&self, actor: ActorId, tick: Tick) -> Option<Command> {
        let spent = *self.held.get(&actor)?;
        (tick - spent.tick <= REPEAT_TICKS).then(|| Command {
            tick,
            input: spent.input.held(),
            ..spent
        })
    }
}
