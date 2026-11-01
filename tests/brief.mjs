import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Runs an npm test script with the thin reporter (tests/brief-reporter.mjs), the same in any shell:
//   npm run brief -- test          npm run brief -- test:slow          npm run brief -- test:physics
// NODE_OPTIONS carries the reporter because node ignores a --test-reporter placed after the file
// globs that `npm test -- <flag>` appends. An absolute URL keeps it valid in scripts that change
// directory (test:mapgen). Exits with the script's status.
const script = process.argv[2];
if (!script) {
  console.error('usage: npm run brief -- <npm test script, e.g. test or test:slow>');
  process.exit(2);
}
const reporter = pathToFileURL(fileURLToPath(new URL('./brief-reporter.mjs', import.meta.url))).href;
const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --test-reporter="${reporter}"`.trim() };
const npm = process.env.npm_execpath;
const result = npm
  ? spawnSync(process.execPath, [npm, 'run', '--silent', script, ...process.argv.slice(3)], { stdio: 'inherit', env })
  : spawnSync('npm', ['run', '--silent', script, ...process.argv.slice(3)], { stdio: 'inherit', env, shell: true });
process.exit(result.status ?? 1);
