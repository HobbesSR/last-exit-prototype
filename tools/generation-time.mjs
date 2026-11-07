#!/usr/bin/env node
/**
 * #767: whole-map `generate` time on 42.31's panel, size-{12,24,36}-1 with #688's parameters,
 * three sequential runs each under the `bench` machine lock. Prints one line per run and a JSON
 * summary with each map's mean and a digest of its output, so a timing change can be checked
 * for identical maps in the same run. Each run reports the process's CPU time beside wall time;
 * on a shared machine, compare versions in alternated pairs (31, #868).
 * Usage: node tools/generation-time.mjs [--maps 12,24,36] [--runs 3] [--library FILE]
 * `--library` is a top-level library file for one zone size, its modules beside it (#849).
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { generate } from '../map/tools/core.ts';
import { readLibraryFile } from '../map/tools/library-files.mts';
import { acquireMachineLock } from '../tests/helpers/machine-lock.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const widths = arg('--maps', '12,24,36').split(',').map(Number);
const runs = Number(arg('--runs', '3'));
const library = process.argv.includes('--library') ? readLibraryFile(arg('--library')) : undefined;
if (library && widths.some(w => w !== library.zoneWidth)) throw new Error(`the library is authored for width ${library.zoneWidth} only`);
const { release } = await acquireMachineLock('bench');
const summary = [];
try {
  for (const width of widths) {
    const seed = `size-${width}-1`;
    const params = { zoneWidth: width, zoneHeight: width / 2, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: .04, lootTierStep: .09 };
    const times = [], cpus = [];
    let digest;
    for (let run = 0; run < runs; run++) {
      const start = performance.now(), cpuStart = process.cpuUsage();
      const map = generate(seed, params, library, 48);
      const seconds = (performance.now() - start) / 1000, used = process.cpuUsage(cpuStart), cpu = (used.user + used.system) / 1e6;
      times.push(seconds); cpus.push(cpu);
      const d = createHash('sha256').update(JSON.stringify(map.results)).digest('hex').slice(0, 16);
      if (digest && d !== digest) throw new Error(`${seed} output differs between runs`);
      digest = d;
      console.error(`${seed} run ${run + 1}: ${seconds.toFixed(2)} s, CPU ${cpu.toFixed(2)} s`);
    }
    const mean = list => +(list.reduce((a, b) => a + b) / list.length).toFixed(2);
    summary.push({ seed, runs: times.map(t => +t.toFixed(2)), mean: mean(times), cpu: cpus.map(t => +t.toFixed(2)), cpuMean: mean(cpus), digest });
  }
} finally { release(); }
console.log(JSON.stringify(summary, null, 2));
