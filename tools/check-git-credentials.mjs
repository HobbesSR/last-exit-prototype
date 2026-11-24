import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Checks all Git worktrees of the current repository (or `--repo <path>`) for
 * credentials embedded in Git URLs (`remote.*.url`, `remote.*.pushurl`,
 * `url.<base>.insteadOf`, `url.<base>.pushInsteadOf`). Reports only the
 * affected worktree, config scope, and redacted config key — never the URL.
 */
function hasEmbeddedCredentials(url) {
  if (/^https?:\/\/[^/@\s]+@/i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(url)) return true;
  return false;
}

function getRepoRoot() {
  const idx = process.argv.indexOf('--repo');
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  return process.cwd();
}

function listWorktrees(repoRoot) {
  const out = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
  const worktrees = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), prunable: false };
    } else if (current && (line === 'prunable' || line.startsWith('prunable '))) {
      current.prunable = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function readUrlConfigs(worktreePath) {
  try {
    const out = execFileSync(
      'git',
      [
        '-C',
        worktreePath,
        'config',
        '--show-scope',
        '--get-regexp',
        '^(remote\\..*\\.(url|pushurl)|url\\..*\\.(insteadof|pushinsteadof))$',
      ],
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

function inspectEntry(entry) {
  const urlMatch = entry.key.match(/^url\.(.+)\.(insteadof|pushinsteadof)$/i);
  if (urlMatch) {
    const [, base, suffix] = urlMatch;
    if (hasEmbeddedCredentials(base)) {
      return `url.<redacted>.${suffix.toLowerCase()}`;
    }
    return null;
  }
  if (hasEmbeddedCredentials(entry.value)) {
    return entry.key;
  }
  return null;
}

const repoRoot = getRepoRoot();
const worktrees = listWorktrees(repoRoot);
const findings = [];
const unreadable = [];

for (const wt of worktrees) {
  if (wt.prunable || !existsSync(wt.path)) {
    unreadable.push(wt.path);
    continue;
  }
  for (const entry of readUrlConfigs(wt.path)) {
    const flaggedKey = inspectEntry(entry);
    if (flaggedKey) {
      findings.push({ worktree: wt.path, scope: entry.scope, key: flaggedKey });
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

const skippedNote = unreadable.length > 0 ? ` (${unreadable.length} prunable/missing skipped)` : '';
console.log(`OK: checked ${worktrees.length - unreadable.length} worktree(s)${skippedNote}; no credentials embedded in Git URLs.`);
