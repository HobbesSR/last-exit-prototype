// Refuses a push to Forgejo unless the pushing identity is pinned to this
// worktree or to the agent's own process, and the pushed commits were made by
// that identity (docs/34). Git Credential Manager picks any stored account when
// no username is pinned, and an unpinned worktree falls back to shared
// identity config, so either would push or commit as someone else silently.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Scopes that belong to one worktree or one agent process: `config.worktree`, or `GIT_CONFIG_*` / `-c`. */
const PINNED = new Set(['worktree', 'command']);
const SHOWN_COMMITS = 5;

/**
 * @param {{ remote: string,
 *   username?: { scope: string, value: string },
 *   name?: { scope: string, value: string },
 *   email?: { scope: string, value: string },
 *   commits: { sha: string, committerEmail: string }[] }} push
 * @returns {string[]} problems; empty when the push may go ahead
 */
export function checkPush({ remote, username, name, email, commits }) {
  const problems = [];
  const pinned = (label, entry) => {
    if (!entry) problems.push(`${label} is not set for ${remote}.`);
    else if (!PINNED.has(entry.scope)) {
      problems.push(`${label} (${entry.value}) comes from ${entry.scope} config, not this worktree or this agent's environment.`);
    }
  };
  pinned('credential username', username);
  pinned('user.name', name);
  pinned('user.email', email);
  if (username && name && isAgent(username.value, name.value) && username.value !== name.value) {
    problems.push(`credential username ${username.value} does not match user.name ${name.value}.`);
  }
  if (email) {
    const foreign = commits.filter((commit) => commit.committerEmail !== email.value);
    for (const commit of foreign.slice(0, SHOWN_COMMITS)) {
      problems.push(`commit ${commit.sha} was committed by ${commit.committerEmail}, not ${email.value}.`);
    }
    if (foreign.length > SHOWN_COMMITS) problems.push(`…and ${foreign.length - SHOWN_COMMITS} more commits by someone else.`);
  }
  return problems;
}

function isAgent(...accounts) {
  return accounts.some((account) => account.startsWith('agent-'));
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (error.status === 1) return ''; // `git config` exits 1 for an unset key
    throw error;
  }
}

function scoped(args) {
  const line = git(['config', '--show-scope', ...args]).split(/\r?\n/).at(-1);
  if (!line) return undefined;
  const tab = line.indexOf('\t');
  return { scope: line.slice(0, tab), value: line.slice(tab + 1) };
}

const ZERO = /^0+$/;

function pushedCommits(remote, updates) {
  const commits = [];
  for (const line of updates.split(/\r?\n/)) {
    const [, localSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // deletions push no commits
    const log = git(['log', '--format=%h %ce', localSha, '--not', `--remotes=${remote}`]);
    for (const entry of log.split(/\r?\n/).filter(Boolean)) {
      const [sha, committerEmail = ''] = entry.split(' ');
      commits.push({ sha, committerEmail });
    }
  }
  return commits;
}

function main([remote, url]) {
  // Only Forgejo carries per-agent accounts; the GitHub copy is pushed by the human.
  if (remote !== 'forgejo') return 0;
  const problems = checkPush({
    remote,
    // A path remote has no URL to match and takes no credentials; it reads as unset.
    username: url?.includes('://') ? scoped(['--get-urlmatch', 'credential.username', url]) : undefined,
    name: scoped(['--get', 'user.name']),
    email: scoped(['--get', 'user.email']),
    commits: pushedCommits(remote, readFileSync(0, 'utf8')),
  });
  if (problems.length === 0) return 0;
  console.error('pre-push: refusing to push to forgejo as an unpinned or mismatched identity (docs/34):');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('Pin the identity in config.worktree or the agent harness environment, then retry. Do not bypass this.');
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
