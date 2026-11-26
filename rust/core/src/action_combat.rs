//! Phase-three combat facts and character motor calculations (27, D1).
use crate::action_equipment::{equipped, sync_weapon};
use crate::action_types::{ABSENT_AMMO, ABSENT_QUALITY, Player, Rules, present, truthy};
use crate::math::{cos, hypot, js_max, js_min, sin};

#[derive(Clone, Debug)]
pub enum Fact {
    Effect {
        id: f64,
        x: f64,
        y: f64,
        kind: usize,
        radius: f64,
    },
    Projectile {
        id: f64,
        owner: usize,
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
        life: f64,
        damage: f64,
    },
    Shot {
        shooter: usize,
        weapon: usize,
    },
}

fn effect(serial: &mut f64, facts: &mut Vec<Fact>, x: f64, y: f64, kind: usize, radius: f64) {
    facts.push(Fact::Effect {
        id: *serial,
        x,
        y,
        kind,
        radius,
    });
    *serial += 1.0;
}

fn slot(p: &Player) -> Option<usize> {
    let selected = if truthy(p.selected) { p.selected } else { 0.0 };
    (selected.is_finite()
        && selected.fract() == 0.0
        && selected >= 0.0
        && selected < p.inventory.as_ref()?.len() as f64)
        .then_some(selected as usize)
}

pub fn attack(p: &mut Player, rules: &Rules, serial: &mut f64, facts: &mut Vec<Fact>) {
    if p.attack_cd > 0.0 || p.role != 0.0 {
        return;
    }
    let Some(item) = equipped(p).cloned() else {
        return;
    };
    if p.reload.is_some() {
        return;
    }
    if item.kind == 1.0 || item.kind == 2.0 {
        if item.kind == 1.0 {
            if p.hp.partial_cmp(&p.max_hp) != Some(std::cmp::Ordering::Less) {
                return;
            }
            p.hp = js_min(p.max_hp, p.hp + rules.utility[0]);
        } else {
            if p.shield.partial_cmp(&rules.utility[2]) != Some(std::cmp::Ordering::Less) {
                return;
            }
            p.shield = js_min(rules.utility[2], p.shield + rules.utility[1]);
        }
        let slot = slot(p).unwrap();
        let inventory = p.inventory.as_mut().unwrap();
        let item = inventory[slot].as_mut().unwrap();
        item.count -= 1.0;
        // equipped falls back to slot zero for an absent selection, but the TypeScript
        // clear indexes selectedSlot directly. Its undefined property does not clear zero.
        if item.count <= 0.0 && !p.selected.is_nan() {
            p.retired.push(item.clone());
            inventory[slot] = None;
        }
        p.attack_cd = rules.hz;
        sync_weapon(p, rules);
        effect(serial, facts, p.x, p.y, 3, 30.0);
        return;
    }
    if item.kind != 0.0
        || !item.weapon.is_finite()
        || item.weapon.fract() != 0.0
        || item.weapon < 0.0
        || item.weapon >= rules.weapons.len() as f64
    {
        return;
    }
    let weapon_index = item.weapon as usize;
    let weapon = &rules.weapons[weapon_index];
    let slot = slot(p).unwrap();
    let carried = p.inventory.as_mut().unwrap()[slot].as_mut().unwrap();
    carried.ammo = carried.value(ABSENT_AMMO, carried.ammo, weapon.ammo);
    carried.absent &= !ABSENT_AMMO;
    if carried.ammo <= 0.0 {
        return;
    }
    carried.ammo -= 1.0;
    p.attack_cd = weapon.cooldown;
    let quality = carried.value(ABSENT_QUALITY, carried.quality, 1.0) - 1.0;
    let multiplier = if quality.is_finite() && quality.fract() == 0.0 && quality >= 0.0 {
        rules
            .quality_damage
            .get(quality as usize)
            .copied()
            .map_or(1.0, |n| present(n, 1.0))
    } else {
        1.0
    };
    for &spread in &weapon.spread {
        facts.push(Fact::Projectile {
            id: *serial,
            owner: p.roster,
            x: p.x,
            y: p.y,
            dx: cos(p.heading + spread) * weapon.speed,
            dy: sin(p.heading + spread) * weapon.speed,
            life: weapon.life,
            damage: weapon.damage * multiplier,
        });
        *serial += 1.0;
    }
    p.cloak = 0.0;
    facts.push(Fact::Shot {
        shooter: p.roster,
        weapon: weapon_index,
    });
}

/// Specter and striker skills. Warden and hook retain their world-dependent owner.
pub fn skill(
    p: &mut Player,
    rules: &Rules,
    serial: &mut f64,
    facts: &mut Vec<Fact>,
    opponents: &[(usize, f64, f64, f64)],
) -> Vec<usize> {
    if p.kit == 0 || p.kit == 3 || p.cooldown > 0.0 || p.role == 0.0 {
        return Vec::new();
    }
    p.cooldown = js_max(45.0, rules.kit_cooldown[p.kit] - (p.level - 1.0) * 12.0);
    if p.kit == 1 {
        effect(serial, facts, p.x, p.y, 1, 450.0);
        opponents
            .iter()
            .filter_map(|&(roster, role, x, y)| {
                (role != p.role && hypot(p.x - x, p.y - y) < 450.0).then_some(roster)
            })
            .collect()
    } else {
        p.boost = 55.0;
        effect(serial, facts, p.x, p.y, 4, 75.0);
        Vec::new()
    }
}

pub fn motor(p: &Player, rules: &Rules, x: f64, y: f64, sneak: bool) -> [f64; 3] {
    let role = usize::from(p.role != 0.0);
    let mut speed = rules.movement[role] * rules.hz;
    if truthy(p.boost) {
        speed *= rules.movement[2 + role];
    }
    if truthy(p.stun) {
        speed *= rules.movement[4];
    }
    if sneak && p.role == 0.0 {
        speed *= rules.movement[5];
    }
    let length = js_max(1.0, hypot(x, y));
    let surface = rules
        .surfaces
        .iter()
        .find(|s| p.x >= s[0] && p.x < s[0] + s[2] && p.y >= s[1] && p.y < s[1] + s[3]);
    let moving = x != 0.0 || y != 0.0;
    let accel = if moving {
        rules.acceleration * surface.map_or(1.0, |s| s[5])
    } else {
        rules.braking * surface.map_or(1.0, |s| s[6])
    };
    [
        x / length * speed * surface.map_or(1.0, |s| s[4]),
        y / length * speed * surface.map_or(1.0, |s| s[4]),
        accel,
    ]
}
