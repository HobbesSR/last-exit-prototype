export const SLOT_COUNT = 5;
export const WEAPONS = {
  pistol: { name: 'Pistol', cooldown: 8, damage: 10, speed: 35, life: 24, spread: [0] },
  rifle: { name: 'Rifle', cooldown: 4, damage: 6, speed: 44, life: 28, spread: [0] },
  scattergun: { name: 'Scattergun', cooldown: 18, damage: 7, speed: 30, life: 12, spread: [-0.18, -0.09, 0, 0.09, 0.18] }
};
export function equipped(p) { return p.inventory?.[p.selectedSlot || 0] || null; }
export function syncWeapon(p) {
  const item = equipped(p);
  p.weapon = item?.kind === 'weapon' ? Object.keys(WEAPONS).indexOf(item.weaponType) + 1 : 0;
}
export function collectEquipment(p, item) {
  const inventory = p.inventory;
  if (!inventory) return false;
  if (item.kind === 'weapon') {
    if (inventory.some(slot => slot?.weaponType === item.weaponType)) return false;
  } else {
    const stack = inventory.find(slot => slot?.kind === item.kind && slot.count < 3);
    if (stack) { stack.count++; return true; }
  }
  const index = inventory.findIndex(slot => !slot);
  if (index < 0) return false;
  inventory[index] = item.kind === 'weapon' ? { kind: 'weapon', weaponType: item.weaponType || 'pistol' } : { kind: item.kind, count: 1 };
  if (!equipped(p) || item.kind === 'weapon' && equipped(p).kind !== 'weapon') p.selectedSlot = index;
  syncWeapon(p); return true;
}
