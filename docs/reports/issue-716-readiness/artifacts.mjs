import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('.', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const walk = prefix => fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
  const file = path.join(prefix, entry.name);
  return entry.isDirectory() ? walk(file) : [file.replaceAll('\\', '/')];
});
const files = Object.fromEntries(walk('').filter(f => f !== 'artifacts.json').sort().map(file => {
  const bytes = fs.readFileSync(path.join(root, file)); return [file, { bytes: bytes.length, sha256: hash(bytes) }];
}));
fs.writeFileSync(path.join(root, 'artifacts.json'), JSON.stringify({ version: 'issue-716-readiness-artifacts-1', files }, null, 2) + '\n', { flag: 'wx' });
console.log(`Pinned ${Object.keys(files).length} report artifacts.`);
