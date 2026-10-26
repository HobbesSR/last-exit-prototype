import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SWATCHES, THEMES, DEFAULT_THEME, themeColors, contrast, mix } from '../public/palette.js';

test('the swatches are 11.1\'s canonical palette export', () => {
  const doc = readFileSync('docs/11.1-world-and-art-direction.md', 'utf8');
  const block = doc.match(/#### Canonical JSON export[^\n]*\r?\n\s*```json\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(block, '11.1 has its canonical JSON block');
  const { version, colors } = JSON.parse(block[1]);
  const { version: ours, ...groups } = SWATCHES;
  assert.equal(ours, version);
  assert.deepEqual(groups, colors);
});

test('every theme fills every role the renderer draws', () => {
  const roles = THEMES.prototype.colors;
  assert.equal(themeColors('no-such-palette'), THEMES[DEFAULT_THEME].colors);
  for (const [id, { label, colors }] of Object.entries(THEMES)) {
    assert.ok(label, id);
    assert.deepEqual(Object.keys(colors).sort(), Object.keys(roles).sort(), id);
    for (const [role, value] of Object.entries(colors)) {
      const values = Array.isArray(roles[role]) ? value : [value];
      if (Array.isArray(roles[role])) assert.equal(value.length, roles[role].length, `${id}.${role}`);
      for (const c of values) assert.ok(Number.isInteger(c) && c >= 0 && c <= 0xffffff, `${id}.${role}`);
    }
  }
});

// 11.1 §5.4: colour must never cost the contrast between where you can walk and what blocks you. An
// obstacle reads by its fill or its outline, whichever differs more from the ground it stands on, and
// must do so lit and in the out-of-sight shade. The prototype's contrast is the floor, capped at 1.5
// where the prototype was already clearer, so a night palette may be moodier but never muddier.
test('no palette blurs walkable surfaces into obstacles, lit or shaded', () => {
  const blockers = c => ({ wall: c.wall, fence: c.fence, hedge: c.hedge, ruin: c.ruin, glass: c.glass, pipe: c.pipe, rock: c.rockMid, ...Object.fromEntries(c.crates.map((v, i) => [`crate${i}`, v])) });
  const shaded = c => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Array.isArray(v) ? v.map(x => mix(x, c.shade, 0.46)) : mix(v, c.shade, 0.46)]));
  const edge = (c, fill, ground) => Math.max(contrast(fill, c[ground]), contrast(c.outline, c[ground]));
  const muddy = [];
  for (const light of [c => c, shaded]) {
    const base = light(THEMES.prototype.colors);
    for (const [id, theme] of Object.entries(THEMES)) {
      const c = light(theme.colors);
      for (const ground of ['ground', 'street', 'floor']) for (const [kind, fill] of Object.entries(blockers(c))) {
        const floor = Math.min(1.5, edge(base, blockers(base)[kind], ground));
        if (edge(c, fill, ground) < floor - 1e-9) muddy.push(`${id}${light === shaded ? ' shaded' : ''}: ${kind} on ${ground} ${edge(c, fill, ground).toFixed(2)} < ${floor.toFixed(2)}`);
      }
      // Roads must still read from the open ground beside them (11.1 §7, value separation).
      if (contrast(c.street, c.ground) < 1.2) muddy.push(`${id}${light === shaded ? ' shaded' : ''}: street on ground ${contrast(c.street, c.ground).toFixed(2)}`);
    }
  }
  assert.deepEqual(muddy, []);
});

test('palettes stay presentation: no simulation, server or map code imports them', () => {
  for (const dir of ['shared', 'server', 'map']) for (const file of readdirSync(dir, { recursive: true })) {
    if (!/\.(m?[jt]s)$/.test(file) || file.includes('node_modules')) continue;
    assert.ok(!/palette\.js/.test(readFileSync(path.join(dir, file), 'utf8')), `${dir}/${file} imports the palette`);
  }
});
