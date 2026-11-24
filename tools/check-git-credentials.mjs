import { execFileSync } from 'node:child_process';

/**
 * Checks all Git worktrees of the current repository (or `--repo <path>`) for
 * credentials embedded in Git URLs (`remote.*.url`, `remote.*.pushurl`,
 * `url.*.insteadOf`). Reports only the affected worktree, config scope, and
 * config key — never the URL itself.
 */
function hasEmbeddedCredentials(url) {
  if (/^https?:\/\/[^/@\s]+@/i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(url)) return true;
  return false;
}

function getRepoRoot() {
  const idx = process.argv.indexOf('--repo');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.cwd();
}

function listWorktrees(repoRoot) {
  const out = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
  return out
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
}

function readUrlConfigs(worktreePath) {
  try {
    const out = execFileSync(
      'git',
      ['-C', worktreePath, 'config', '--show-scope', '--get-regexp', '^(remote\\..*\\.(url|pushurl)|url\\..*\\.insteadof)$'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        const scope = tab === -1 ? 'unknown' : line.slice(0, tab);
        const rest = tab === -1 ? line : line.slice(tab + 1);
        const space = rest.indexOf(' ');
        const key = space === -1 ? rest : rest.slice(0, space);
        const value = space === -1 ? '' : rest.slice(space + 1);
        return { scope, key, value };
      });
  } catch (err) {
    if (err.status === 1 && !err.stderr) return [];
    throw err;
  }
}

const repoRoot = getRepoRoot();
const worktrees = listWorktrees(repoRoot);
const findings = [];

for (const wt of worktrees) {
  for (const entry of readUrlConfigs(wt)) {
    if (hasEmbeddedCredentials(entry.value)) {
      findings.push({ worktree: wt, scope: entry.scope, key: entry.key });
    }
  }
}

if (findings.length > 0) {
  console.error('Found credentials embedded in Git URLs (URLs omitted):');
  for (const f of findings) {
    console.error(`  worktree=${f.worktree} scope=${f.scope} key=${f.key}`);
  }
  process.exit(1);
}

console.log(`OK: checked ${worktrees.length} worktree(s); no credentials embedded in Git URLs.`);
