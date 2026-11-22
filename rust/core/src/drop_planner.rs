//! Transactional L0/L2 drops and item identity allocation (27, D6 and step 5c.2).
//! The adapter supplies unused legacy label phases; labels remain compatibility metadata in JS.

use crate::action_equipment::valid_payload;
use crate::action_types::{
    ABSENT_AMMO, ABSENT_CHARGE, ABSENT_INSTANCE, ABSENT_LINEAGE, ABSENT_QUALITY, ABSENT_WEAPON,
    Item, MAX_SAFE, Rules, safe, truthy,
};
use crate::collision::CollisionMap;
use crate::placement::Disk;
use crate::scatter::scatter_point;
use crate::sight::{GateSet, SightIndex};
use crate::world::World;

#[derive(Clone)]
pub struct Allocation {
    pub item_serial: f64,
    pub scatter_serial: f64,
    /// Sorted unused `instance-N` label phases, packed only for allocating intents.
    pub phases: Vec<f64>,
    /// Relevant registered IDs, including disappeared lineage roots.
    pub registered: Vec<f64>,
    /// New registrations, in allocation order: numeric ID, legacy label phase.
    pub facts: Vec<[f64; 2]>,
    /// The world's item registry (#1214 stage 6e.1), where the run reads it: then `phases` and `registered` hold only
    /// this run's allocations, and the free phases and registered IDs are the registry's.
    pub registry: Option<std::rc::Rc<crate::registry::Registry>>,
}

fn valid_id(id: f64) -> bool {
    safe(id) && id > 0.0
}

impl Allocation {
    /// `allocateItemId`: skip reserved labels without consuming a numeric ID.
    pub fn allocate(&mut self) -> Option<f64> {
        if !safe(self.scatter_serial) || self.scatter_serial < 0.0 {
            return None;
        }
        let phase = match &self.registry {
            // The first phase from the scatter serial whose `instance-N` label is free, as `allocateItemId` scans.
            Some(registry) => {
                let mut phase = self.scatter_serial;
                while phase < MAX_SAFE && registry.reserved(phase) {
                    phase += 1.0;
                }
                phase
            }
            None => self
                .phases
                .iter()
                .copied()
                .find(|phase| *phase >= self.scatter_serial)?,
        };
        if !safe(phase)
            || phase >= MAX_SAFE
            || !safe(self.item_serial)
            || self.item_serial < 1.0
            || self.item_serial >= MAX_SAFE
        {
            return None;
        }
        let id = self.item_serial;
        self.item_serial = id + 1.0;
        self.scatter_serial = phase + 1.0;
        self.registered.push(id);
        self.facts.push([id, phase]);
        Some(id)
    }

    /// Whether `id` is registered: by this run, or in the world's registry where the run reads it.
    pub fn holds(&self, id: f64) -> bool {
        self.registered.contains(&id) || self.registry.as_ref().is_some_and(|r| r.holds(id))
    }

    /// `ensureItemIdentity`: validate metadata, allocate if absent, and resolve both labels.
    pub fn ensure(&mut self, item: &mut Item) -> bool {
        self.ensure_checked(item).is_ok()
    }

    /// Preserve the throwing caller's error and the writes made before label resolution fails.
    pub fn ensure_checked(&mut self, item: &mut Item) -> Result<(), (i32, f64)> {
        if !item.missing(ABSENT_QUALITY)
            && !(safe(item.quality) && (1.0..=5.0).contains(&item.quality))
            || !item.missing(ABSENT_INSTANCE) && !valid_id(item.instance)
            || !item.missing(ABSENT_LINEAGE) && !valid_id(item.lineage)
        {
            return Err((-103, 0.0));
        }
        if item.missing(ABSENT_INSTANCE) {
            if !safe(self.scatter_serial) || self.scatter_serial < 0.0 {
                return Err((-101, 0.0));
            }
            let Some(id) = self.allocate() else {
                return Err((-102, 0.0));
            };
            item.instance = id;
            item.absent &= !ABSENT_INSTANCE;
        }
        if item.missing(ABSENT_LINEAGE) {
            item.lineage = item.instance;
            item.absent &= !ABSENT_LINEAGE;
        }
        if !self.holds(item.instance) {
            return Err((-104, item.instance));
        }
        if !self.holds(item.lineage) {
            return Err((-104, item.lineage));
        }
        Ok(())
    }
}

pub struct Record {
    pub item: Item,
    pub id: f64,
    pub x: f64,
    pub y: f64,
    pub family: f64,
}

pub struct Plan {
    pub records: Vec<Record>,
    pub allocation: Allocation,
}

pub struct Context<'a> {
    pub world: &'a mut World,
    pub map: &'a mut CollisionMap,
    pub index: &'a SightIndex,
    pub gates: &'a mut GateSet,
    pub actors: &'a [Disk],
    pub taken: &'a [[f64; 2]],
    pub ground_ids: &'a [f64],
    /// Every inventory identity except the object being dropped.
    pub carried_ids: &'a [f64],
    pub ground_count: usize,
}

fn point(
    ctx: &mut Context<'_>,
    rules: &Rules,
    origin: (f64, f64),
    phase: f64,
    taken: &[[f64; 2]],
) -> Option<(f64, f64)> {
    scatter_point(
        ctx.world,
        ctx.map,
        ctx.index,
        ctx.gates,
        origin,
        phase,
        rules.loot_radius,
        ctx.actors,
        taken,
    )
}

/// Plan the entire carried object before publishing either counter or any ground record.
pub fn plan_drop(
    ctx: &mut Context<'_>,
    rules: &Rules,
    origin: (f64, f64),
    item: &Item,
    mandatory: bool,
    allocation: &Allocation,
) -> Option<Plan> {
    if ![0.0, 1.0, 2.0, 3.0].contains(&item.kind)
        || !origin.0.is_finite()
        || !origin.1.is_finite()
        || !valid_payload(item, rules)
    {
        return None;
    }
    let copies = if item.kind == 1.0 || item.kind == 2.0 {
        item.count
    } else {
        1.0
    };
    if !safe(copies)
        || !(1.0..=3.0).contains(&copies)
        || item.kind == 0.0 && (!safe(item.ammo) || item.ammo < 0.0)
        || item.kind == 3.0 && (!safe(item.charge) || item.charge < 0.0)
    {
        return None;
    }
    if !mandatory && ctx.ground_count as f64 + copies > rules.ground_capacity {
        return None;
    }
    let mut taken = ctx.taken.to_vec();
    let mut points = Vec::with_capacity(copies as usize);
    for i in 0..copies as usize {
        let at = point(
            ctx,
            rules,
            origin,
            allocation.scatter_serial + i as f64,
            &taken,
        );
        let at = match at {
            Some(at) => at,
            None if mandatory => origin,
            None => return None,
        };
        // Fallbacks join the same list, even if the next search also fails.
        taken.push([at.0, at.1]);
        points.push(at);
    }
    if truthy(item.instance)
        && (ctx.ground_ids.contains(&item.instance) || ctx.carried_ids.contains(&item.instance))
    {
        return None;
    }
    let mut staged = allocation.clone();
    let mut identity = item.clone();
    if !staged.ensure(&mut identity) {
        return None;
    }
    let mut records = Vec::with_capacity(points.len());
    for (i, (x, y)) in points.into_iter().enumerate() {
        let id = if i == 0 {
            identity.instance
        } else {
            staged.allocate()?
        };
        let mut ground = Item {
            kind: item.kind,
            weapon: f64::NAN,
            ammo: f64::NAN,
            count: f64::NAN,
            charge: f64::NAN,
            instance: f64::NAN,
            lineage: identity.lineage,
            quality: item.quality,
            token: item.token,
            absent: ABSENT_AMMO
                | ABSENT_CHARGE
                | ABSENT_INSTANCE
                | ABSENT_WEAPON
                | (item.absent & ABSENT_QUALITY),
        };
        if item.kind == 0.0 {
            ground.weapon = item.weapon;
            ground.ammo = item.ammo;
            ground.absent = (ground.absent & !ABSENT_AMMO & !ABSENT_WEAPON)
                | (item.absent & (ABSENT_AMMO | ABSENT_WEAPON));
        } else if item.kind == 3.0 {
            ground.charge = item.charge;
            ground.absent = (ground.absent & !ABSENT_CHARGE) | (item.absent & ABSENT_CHARGE);
        } else {
            ground.count = 1.0;
        }
        records.push(Record {
            item: ground,
            id,
            x,
            y,
            family: f64::NAN,
        });
    }
    Some(Plan {
        records,
        allocation: staged,
    })
}

pub fn plan_ammo(
    ctx: &mut Context<'_>,
    rules: &Rules,
    origin: (f64, f64),
    family: f64,
    count: f64,
    mandatory: bool,
    allocation: &Allocation,
) -> Option<Plan> {
    if !safe(count) || count < 1.0 || !origin.0.is_finite() || !origin.1.is_finite() {
        return None;
    }
    if !mandatory && ctx.ground_count as f64 + 1.0 > rules.ground_capacity {
        return None;
    }
    let taken = ctx.taken;
    let at = point(ctx, rules, origin, allocation.scatter_serial, taken);
    let (x, y) = match at {
        Some(at) => at,
        None if mandatory => origin,
        None => return None,
    };
    let mut staged = allocation.clone();
    let id = staged.allocate()?;
    let item = Item {
        kind: 5.0,
        weapon: f64::NAN,
        ammo: f64::NAN,
        count,
        charge: f64::NAN,
        instance: f64::NAN,
        lineage: id,
        quality: f64::NAN,
        token: f64::NAN,
        absent: ABSENT_AMMO | ABSENT_CHARGE | ABSENT_INSTANCE | ABSENT_QUALITY | ABSENT_WEAPON,
    };
    Some(Plan {
        records: vec![Record {
            item,
            id,
            x,
            y,
            family,
        }],
        allocation: staged,
    })
}
