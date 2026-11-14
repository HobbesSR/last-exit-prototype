/** Every round of a family in the match: ground weapons and pickups, magazines and reserves. */
export function rounds(s, family) {
  const weaponFamily = type => s.content.reloading.weapons[type].family;
  let total = 0;
  for (const item of s.map.items) {
    if (item.kind === 'ammo' && item.family === family) total += item.count;
    if (item.kind === 'weapon' && weaponFamily(item.weaponType ?? 'pistol') === family) total += item.ammo;
  }
  for (const p of s.players) {
    total += p.reserves?.[family] ?? 0;
    for (const item of p.inventory ?? []) if (item?.kind === 'weapon' && weaponFamily(item.weaponType) === family) total += item.ammo;
  }
  return total;
}
