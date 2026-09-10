export const SLOT_COUNT = 6;
export const WEAPONS = {
  pistol: { name: 'Pistol', ammo: 48, maxAmmo: 192, cooldown: 8, damage: 10, speed: 35, life: 24, spread: [0] },
  rifle: { name: 'Rifle', ammo: 90, maxAmmo: 360, cooldown: 4, damage: 6, speed: 44, life: 28, spread: [0] },
  scattergun: { name: 'Scattergun', ammo: 24, maxAmmo: 96, cooldown: 18, damage: 7, speed: 30, life: 12, spread: [-0.18, -0.09, 0, 0.09, 0.18] }
};
export function equipped(p) { return p.inventory?.[p.selectedSlot || 0] || null; }
export function carriedCell(p) { return equipped(p)?.kind === 'cell' ? equipped(p) : p.inventory?.find(item => item?.kind === 'cell') || null; }
export function syncWeapon(p) {
  const item = equipped(p);
  p.weapon = item?.kind === 'weapon' ? Object.keys(WEAPONS).indexOf(item.weaponType) + 1 : 0;
}
export function collectEquipment(p, item) {
  const inventory = p.inventory;
  if (!inventory) return false;
  if (item.kind === 'weapon') {
    const type = item.weaponType || 'pistol', weapon = WEAPONS[type];
    if (!weapon) return false;
    const existing = inventory.find(slot => slot?.weaponType === type);
    if (existing) {
      existing.ammo ??= weapon.ammo;
      const incoming = item.ammo ?? weapon.ammo;
      const transfer = Math.min(incoming, weapon.maxAmmo - existing.ammo);
      if (transfer <= 0) return false;
      existing.ammo += transfer; item.ammo = incoming - transfer;
      return item.ammo === 0; // A partly used weapon pickup remains on the ground.
    }
  } else if (item.kind !== 'cell') {
    const stack = inventory.find(slot => slot?.kind === item.kind && slot.count < 3);
    if (stack) { stack.count++; return true; }
  }
  const index = inventory.findIndex(slot => !slot);
  if (index < 0) return false;
  inventory[index] = item.kind === 'weapon' ? { kind: 'weapon', weaponType: item.weaponType || 'pistol', ammo: item.ammo ?? WEAPONS[item.weaponType || 'pistol'].ammo }
    : item.kind === 'cell' ? { kind: 'cell', charge: item.charge || 0 } : { kind: item.kind, count: 1 };
  if (!equipped(p) || item.kind === 'weapon' && equipped(p).kind !== 'weapon') p.selectedSlot = index;
  syncWeapon(p); return true;
}

export function rearrangeEquipment(p, from, to) {
  if (!p.inventory || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= p.inventory.length || to >= p.inventory.length || from === to) return false;
  const source = p.inventory[from], target = p.inventory[to];
  if (!source) return false;
  if (target && ['med', 'shield'].includes(source.kind) && target.kind === source.kind) {
    const transfer = Math.min(source.count, 3 - target.count);
    if (transfer <= 0) return false;
    target.count += transfer; source.count -= transfer;
    if (!source.count) { p.inventory[from] = null; if (p.selectedSlot === from) p.selectedSlot = to; }
  } else {
    [p.inventory[from], p.inventory[to]] = [target, source];
    if (p.selectedSlot === from) p.selectedSlot = to;
    else if (p.selectedSlot === to) p.selectedSlot = from;
  }
  syncWeapon(p); return true;
}
