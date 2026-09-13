import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

// JavaScript is parsed exactly as Node would load it. TypeScript is verified to erase cleanly,
// which is the equivalent guarantee: Node strips these modules at load time rather than parsing
// them, so a non-erasable construct is what would actually break the server or the browser.
// Type correctness is a separate, stronger pass — `npm run typecheck`.
for (const root of ['server', 'shared', 'public', 'tests']) {
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
