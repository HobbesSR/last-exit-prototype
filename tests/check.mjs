import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { encodingDamage } from '../tools/lib/encoding-damage.mjs';

// JavaScript is parsed exactly as Node would load it. TypeScript is verified to erase cleanly,
// which is the equivalent guarantee: Node strips these modules at load time rather than parsing
// them, so a non-erasable construct is what would actually break the server or the browser.
// Type correctness is a separate, stronger pass — `npm run typecheck`, which also covers the
// map/*.ts entry modules and map/tools' .mts files that this walk does not strip. map/macro is
// left to its own gate, `npm run test:mapgen`, which typechecks it before running its tests.
for (const root of ['server', 'shared', 'map/micro', 'map/kernel', 'map/tools', 'public', 'tests', 'tools']) {
  for (const file of readdirSync(root, { recursive: true })) {
    const target = `${root}/${file}`;
    if (/\.(js|mjs)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', target], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    } else if (/\.ts$/.test(file) && !file.endsWith('.d.ts')) {
      try {
        stripTypeScriptTypes(readFileSync(target, 'utf8'), { mode: 'strip' });
      } catch (error) {
        console.error(`${target}: ${error.message}`);
        process.exit(1);
      }
    }
  }
}

// Encoding damage in any tracked text file (#1179). Windows tools add byte-order marks and
// double-encode UTF-8 (tools/lib/encoding-damage.mjs). Skipped: binaries, files whose attributes
// keep their bytes as-is (-text), and docs/reports/, which retains historical evidence unchanged.
const tracked = spawnSync('git', ['ls-files', '--eol'], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (tracked.status !== 0) {
  console.error(tracked.stderr);
  process.exit(1);
}
const damaged = [];
for (const entry of tracked.stdout.split('\n')) {
  const [info, file] = entry.split('\t');
  if (!file || info.startsWith('i/-text') || /attr\/\S*-text/.test(info) || file.startsWith('docs/reports/')) continue;
  for (const problem of encodingDamage(readFileSync(file))) damaged.push(`${file}: ${problem}`);
}
if (damaged.length) {
  console.error(`Encoding damage (#1179); rewrite these as UTF-8 without a byte-order mark:\n  ${damaged.join('\n  ')}`);
  process.exit(1);
}
