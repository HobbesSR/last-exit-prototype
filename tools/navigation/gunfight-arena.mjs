// Does a gladiator reach a gunfight at distance D, and how fast? (#697, 42.22 "Bots act on what they hear")
// On the gunfight arena, ticks until the gladiator is within 400 of the shooter, per content, distance and how
// long the shooting lasts. `CONTENTS=content-8,content-9 SCATTER=0.3 node tools/navigation/gunfight-arena.mjs`
import { gunfight } from '../../tests/helpers/scenario.js';
import { contentById } from '../../shared/simulation/content.ts';
import { HZ } from '../../shared/simulation.ts';

const contents = (process.env.CONTENTS ?? 'content-8,content-9').split(',');
const scatter = process.env.SCATTER ? { density: Number(process.env.SCATTER), seed: 7 } : undefined;
// Each weapon at distances inside its content-8 range, the shooting sustained, for ten seconds, or one shot.
const cases = [[2000, 'pistol'], [4000, 'pistol'], [7500, 'pistol'], [9500, 'rifle'], [11500, 'scattergun']];
const spans = [['sustained', undefined], ['10 s', 10 * HZ], ['one shot', 1]];
console.log(`| Distance | Weapon | Content | ${spans.map(([name]) => name).join(' | ')} |`);
console.log(`| ---: | --- | --- | ${spans.map(() => '---:').join(' | ')} |`);
for (const [distance, weapon] of cases) for (const id of contents) {
  const cells = [];
  for (const [, until] of spans) {
    const tick = await gunfight(distance, { content: contentById(id), weapon, until, scatter });
    cells.push(tick === null ? 'no' : `${tick} (${(tick / HZ).toFixed(1)} s)`);
  }
  console.log(`| ${distance} | ${weapon} | ${id} | ${cells.join(' | ')} |`);
}
