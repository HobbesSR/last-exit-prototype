//! Carried equipment and reload transitions, in the TypeScript write order (27, D1/D6).
use crate::action_types::{
    ABSENT_AMMO, ABSENT_CHARGE, ABSENT_INSTANCE, ABSENT_LINEAGE, ABSENT_QUALITY, ABSENT_WEAPON,
    Item, Player, Rules, Weapon, present, safe, truthy,
};
use crate::drop_planner::Allocation;
use crate::math::js_min;

fn index(n: f64, len: usize) -> Option<usize> {
    (n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n < len as f64).then_some(n as usize)
}

fn selected_index(p: &Player) -> Option<usize> {
    let inventory = p.inventory.as_ref()?;
    index(
        if truthy(p.selected) { p.selected } else { 0.0 },
        inventory.len(),
    )
}

pub fn equipped(p: &Player) -> Option<&Item> {
    p.inventory.as_ref()?.get(selected_index(p)?)?.as_ref()
}

fn weapon_rule<'a>(item: &Item, rules: &'a Rules) -> Option<&'a Weapon> {
    rules.weapons.get(index(item.weapon, rules.weapons.len())?)
}

pub fn sync_weapon(p: &mut Player, rules: &Rules) {
    p.weapon = equipped(p)
        .filter(|item| item.kind == 0.0)
        .and_then(|item| index(item.weapon, rules.weapons.len()))
        .map_or(0.0, |weapon| weapon as f64 + 1.0);
}

fn valid_id(n: f64) -> bool {
    safe(n) && n > 0.0
}

/// Validate a carried payload. Access and ammo records require a ground `id` in TypeScript,
/// so neither is legal in these inventory-only records.
pub fn valid_payload(item: &Item, rules: &Rules) -> bool {
    if !(item.missing(ABSENT_QUALITY)
        || item.quality.fract() == 0.0 && (1.0..=5.0).contains(&item.quality))
        || !item.missing(ABSENT_INSTANCE) && !valid_id(item.instance)
        || !item.missing(ABSENT_LINEAGE) && !valid_id(item.lineage)
    {
        return false;
    }
    match item.kind {
        0.0 => {
            let Some(spec) = rules.weapons.get(
                match index(
                    item.value(ABSENT_WEAPON, item.weapon, 0.0),
                    rules.weapons.len(),
                ) {
                    Some(i) => i,
                    None => return false,
                },
            ) else {
                return false;
            };
            let ammo = item.value(ABSENT_AMMO, item.ammo, spec.ammo);
            let limit = if rules.reloading {
                spec.reload
                    .map_or(spec.max_ammo, |rule| present(rule[1], spec.max_ammo))
            } else {
                spec.max_ammo
            };
            safe(ammo) && ammo >= 0.0 && ammo <= limit
        }
        1.0 | 2.0 => safe(item.count) && item.count > 0.0 && item.count <= 3.0,
        3.0 => {
            let charge = item.value(ABSENT_CHARGE, item.charge, 0.0);
            safe(charge) && charge >= 0.0
        }
        _ => false,
    }
}

fn valid_identity_state(p: &Player, rules: &Rules, allocation: &Allocation) -> bool {
    if !safe(rules.ground_capacity)
        || rules.ground_capacity < 0.0
        || !safe(allocation.item_serial)
        || allocation.item_serial < 0.0
    {
        return false;
    }
    let Some(inventory) = &p.inventory else {
        return false;
    };
    if inventory.len() != 6 {
        return false;
    }
    let mut ids = Vec::with_capacity(6);
    for item in inventory.iter().flatten() {
        if !valid_payload(item, rules) || truthy(item.instance) && ids.contains(&item.instance) {
            return false;
        }
        if truthy(item.instance) {
            ids.push(item.instance);
        }
    }
    true
}

fn prepare_carried(p: &mut Player, allocation: &mut Allocation) -> Result<(), (i32, f64)> {
    for item in p.inventory.iter_mut().flatten().flatten() {
        allocation.ensure_checked(item)?;
    }
    Ok(())
}

pub fn rearrange(
    p: &mut Player,
    rules: &Rules,
    from: f64,
    to: f64,
    allocation: &mut Allocation,
) -> Result<bool, (i32, f64)> {
    if !valid_identity_state(p, rules, allocation) {
        return Ok(false);
    }
    let (Some(from_index), Some(to_index)) = (index(from, 6), index(to, 6)) else {
        return Ok(false);
    };
    if from_index == to_index {
        return Ok(false);
    }
    let inventory = p.inventory.as_ref().unwrap();
    let Some(source) = &inventory[from_index] else {
        return Ok(false);
    };
    let merge = inventory[to_index].as_ref().is_some_and(|target| {
        (source.kind == 1.0 || source.kind == 2.0)
            && source.kind == target.kind
            && source.value(ABSENT_QUALITY, source.quality, 1.0)
                == target.value(ABSENT_QUALITY, target.quality, 1.0)
    });
    let transfer = if merge {
        let transfer = source
            .count
            .min(3.0 - inventory[to_index].as_ref().unwrap().count);
        if transfer <= 0.0 {
            return Ok(false);
        }
        transfer
    } else {
        0.0
    };
    // Identity preparation is ordered and may have made partial progress on failure.
    prepare_carried(p, allocation)?;
    let inventory = p.inventory.as_mut().unwrap();
    if merge {
        inventory[to_index].as_mut().unwrap().count += transfer;
        let source = inventory[from_index].as_mut().unwrap();
        source.count -= transfer;
        if !truthy(source.count) {
            p.retired.push(source.clone());
            inventory[from_index] = None;
            if p.selected == from {
                p.selected = to;
            }
        }
    } else {
        inventory.swap(from_index, to_index);
        if p.selected == from {
            p.selected = to;
        } else if p.selected == to {
            p.selected = from;
        }
    }
    sync_weapon(p, rules);
    Ok(true)
}

// Both absent properties compare equal in TypeScript (`undefined === undefined`).
fn same_optional(a: f64, b: f64) -> bool {
    a == b || a.is_nan() && b.is_nan()
}

pub fn advance_reload(p: &mut Player, rules: &Rules, tick: f64, reload_pressed: bool) {
    if !rules.reloading || p.reserves.is_none() {
        return;
    }
    let weapon = equipped(p).filter(|item| item.kind == 0.0);
    if let Some(reload) = p.reload {
        if p.stun > 0.0
            || !same_optional(p.selected, reload[0])
            || weapon.is_none_or(|weapon| !same_optional(weapon.instance, reload[1]))
        {
            p.reload = None;
        } else if tick >= reload[2] {
            let weapon = weapon.unwrap();
            let rule = weapon_rule(weapon, rules)
                .and_then(|spec| spec.reload)
                .expect("active reload has a weapon rule");
            let family = index(rule[0], 3).expect("reload family is in the fixed vocabulary");
            let transfer = js_min(rule[1] - weapon.ammo, p.reserves.unwrap()[family]);
            let slot = selected_index(p).unwrap();
            p.inventory.as_mut().unwrap()[slot].as_mut().unwrap().ammo += transfer;
            p.inventory.as_mut().unwrap()[slot].as_mut().unwrap().absent &= !ABSENT_AMMO;
            p.reserves.as_mut().unwrap()[family] -= transfer;
            p.reload = None;
            return;
        }
    }
    let weapon = equipped(p).filter(|item| item.kind == 0.0);
    if !reload_pressed
        || p.reload.is_some()
        || p.stun > 0.0
        || weapon.is_none_or(|weapon| !truthy(weapon.instance))
    {
        return;
    }
    let weapon = weapon.unwrap();
    let Some(rule) = weapon_rule(weapon, rules).and_then(|spec| spec.reload) else {
        return;
    };
    let Some(family) = index(rule[0], 3) else {
        return;
    };
    if weapon.ammo >= rule[1] || p.reserves.unwrap()[family] <= 0.0 {
        return;
    }
    p.reload = Some([p.selected, weapon.instance, tick + rule[2]]);
}
