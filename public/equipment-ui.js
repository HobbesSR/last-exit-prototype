import { WEAPONS } from '/shared/equipment.js';

// Code-native glyphs match the existing outlined HUD. Names remain in tooltips and ARIA labels.
const paths = {
  pistol: 'M3 7h16v5H11v8H6v-8H3z M16 7V5',
  rifle: 'M2 9h18v4H9v6H6v-6H2z M20 10h3 M13 9V6h4v3',
  scattergun: 'M2 8h21v4H10l-4 8H2l4-8H2z M14 8v4',
  med: 'M8 3h8v5h5v8h-5v5H8v-5H3V8h5z',
  shield: 'M12 2l9 4v7c0 4-5 8-9 10-4-2-9-6-9-10V6z',
  cell: 'M9 2h6v3H9z M6 5h12v17H6z M13 8l-4 6h4l-2 5',
};
export function slotPresentation(item, chargeTicks = 100) {
  if (!item) return { name: 'Empty', glyph: '', count: '', key: 'empty' };
  const kind = item.weaponType || item.kind;
  const name = item.kind === 'weapon' ? WEAPONS[kind]?.name || kind : { med: 'Medkit', shield: 'Shield', cell: 'Power cell' }[kind] || kind;
  const count = item.kind === 'weapon' ? String(item.ammo ?? WEAPONS[kind]?.ammo ?? 0) : item.kind === 'cell' ? `${Math.floor(item.charge / chargeTicks * 100)}%` : String(item.count);
  const glyph = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="${paths[kind] || paths.cell}"/></svg>`;
  return { name, glyph, count, key: `${kind}:${count}` };
}
