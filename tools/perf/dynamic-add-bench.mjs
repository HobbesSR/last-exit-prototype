import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
const root = new URL('../../', import.meta.url);
await mkdir(new URL('test-results/', root), { recursive: true });
const scratch = pathToFileURL((await mkdtemp(resolve(fileURLToPath(new URL('test-results/', root)), 'dynamic-add-'))) + '/');

// Isolated diagnostic, not a test gate. No shared source swapping is needed.
const statics = +(process.env.STATICS ?? 20000);
const rounds = +(process.env.ROUNDS ?? 5);
const additions = 96;
const variants = ['base', 'optimized'];
const factories = {};
for (const variant of variants) {
  const source = variant === 'base'
    ? execFileSync('git', ['show', '6249b40:shared/physics/world.ts'], { cwd: root, encoding: 'utf8' })
    : await readFile(new URL('shared/physics/world.ts', root), 'utf8');
  const isolated = source.replaceAll("from './", "from '../../shared/physics/")
    .replaceAll("from '../math.ts'", "from '../../shared/math.ts'");
  const target = new URL(`./world-${variant}.ts`, scratch);
  await writeFile(target, isolated);
  factories[variant] = await (await import(target.href)).createPhysicsWorldFactory();
}

const run = variant => {
  const world = factories[variant]();
  try {
    for (let i = 0; i < statics; i++) {
      world.queueAddBody({ id: `wall:${String(i).padStart(6, '0')}`, kind: 'static', mapGeometry: true,
        shape: { kind: 'box', hx: 2, hy: 2 }, x: (i % 200) * 30, y: 1000 + Math.floor(i / 200) * 30 });
      if (i % 512 === 511) world.commitMutations();
    }
    world.commitMutations();
    let elapsed = 0, cpuMs = 0;
    const hash = createHash('sha256');
    for (let round = 0; round < rounds; round++) {
      const start = performance.now(), cpuStart = process.cpuUsage();
      // Each drop commits immediately, matching the costly elimination-drop path.
      for (let i = additions - 1; i >= 0; i--) {
        world.queueAddBody({ id: `drop:${String(i).padStart(3, '0')}`, kind: 'prop',
          collisionProfile: 'loot', shape: { kind: 'circle', radius: 12 }, x: i * 40, y: 0 });
        world.commitMutations();
      }
      elapsed += performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      cpuMs += (cpu.user + cpu.system) / 1000;
      hash.update(JSON.stringify(world.snapshot({ includeStatic: false })));
      for (let i = 0; i < additions; i++) world.queueRemoveBody(`drop:${String(i).padStart(3, '0')}`);
      world.commitMutations();
    }
    return { variant, statics, rounds, commits: rounds * additions, milliseconds: elapsed, cpuMilliseconds: cpuMs, digest: hash.digest('hex') };
  } finally { world.dispose(); }
};

const lock = await acquireMachineLock('bench');
const results = [];
try {
  for (let repeat = 1; repeat <= 3; repeat++) {
    const pair = [];
    for (const variant of variants) {
      const result = { repeat, ...run(variant), contention: lock.contention() };
      results.push(result); pair.push(result);
      console.log(JSON.stringify(result));
    }
    assert.equal(pair[0].digest, pair[1].digest, 'base/candidate dynamic states differ');
  }
  await writeFile(new URL('./dynamic-add-results.json', scratch), JSON.stringify(results, null, 2) + '\n');
} finally {
  lock.release();
}


