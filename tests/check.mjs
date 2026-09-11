import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const root of ['server', 'shared', 'public', 'tests']) {
  for (const file of readdirSync(root, { recursive: true }).filter(f => /\.(js|mjs)$/.test(f))) {
    const result = spawnSync(process.execPath, ['--check', `${root}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
