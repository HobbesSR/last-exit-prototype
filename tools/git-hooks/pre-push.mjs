// Refuses a push to Forgejo unless the pushing identity is pinned to this
// worktree, to the checked-out branch's agent namespace or to the agent's own
// process, the pushed commits were made by that identity, and an agent pushes
// only its own namespace (docs/34). Git Credential Manager picks any stored
// account when no username is pinned, and an unpinned worktree falls back to
// shared identity config, so either would push or commit as someone else silently.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Scopes that belong to one worktree, one branch namespace or one agent process:
 * `config.worktree`, an `includeIf "onbranch:<agent>/**"` identity file, or
 * `GIT_CONFIG_*` / `-c`.
 */
const PINNED = new Set(['worktree', 'branch', 'command']);
const SHOWN_COMMITS = 5;

/**
 * @param {{ remote: string,
 *   username?: { scope: string, value: string },
 *   name?: { scope: string, value: string },
 *   email?: { scope: string, value: string },
 *   commits: { sha: string, committerEmail: string }[],
 *   refs?: string[] }} push `refs` are the remote refs being updated or deleted
 * @returns {string[]} problems; empty when the push may go ahead
 */
export function checkPush({ remote, username, name, email, commits, refs = [] }) {
  const problems = [];
  const pinned = (label, entry) => {
    if (!entry) problems.push(`${label} is not set for ${remote}.`);
    else if (!PINNED.has(entry.scope)) {
      problems.push(`${label} (${entry.value}) comes from ${entry.scope} config, not this worktree, this branch's agent include or this agent's environment.`);
    }
  };
  pinned('credential username', username);
  pinned('user.name', name);
  pinned('user.email', email);
  if (username && name && isAgent(username.value, name.value) && username.value !== name.value) {
    problems.push(`credential username ${username.value} does not match user.name ${name.value}.`);
  }
  if (username && isAgent(username.value)) {
    const namespace = `refs/heads/${username.value.slice('agent-'.length)}/`;
    for (const ref of refs.filter((ref) => !ref.startsWith(namespace))) {
      problems.push(`${username.value} may push only ${namespace}*, not ${ref}.`);
    }
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

const normalFile = (file) => file.replace(/^file:/, '').replaceAll('\\', '/').toLowerCase();

/**
 * The scope an entry counts as: `local` config read from one of the shared config's
 * `includeIf "onbranch:…"` files is the checked-out branch's identity, `branch`.
 * Anything else in the shared config applies to every worktree, so stays `local`.
 *
 * @param {{ scope: string, origin: string }} entry `origin` as `git config --show-origin` prints it
 * @param {Set<string>} branchFiles the onbranch include files, normalised
 */
export function pinScope({ scope, origin }, branchFiles) {
  return scope === 'local' && branchFiles.has(normalFile(origin)) ? 'branch' : scope;
}

/** The files the shared config includes by branch, resolved as git resolves include paths. */
function branchIncludeFiles() {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const records = git(['config', '--file', path.join(common, 'config'), '--null', '--get-regexp', '^includeif\\.onbranch:.*\\.path$']).split('\0');
  const files = new Set();
  for (const record of records) {
    const newline = record.indexOf('\n');
    const file = newline < 0 ? '' : record.slice(newline + 1);
    if (!file) continue;
    files.add(normalFile(file.startsWith('~/') ? path.join(homedir(), file.slice(2)) : path.resolve(common, file)));
  }
  return files;
}

/** The last value of `key` with the scope it counts as; NUL-delimited as `scope\0origin\0value\0`. */
function scoped(key, branchFiles) {
  const [scope, origin, value] = git(['config', '--null', '--show-scope', '--show-origin', '--get', key]).split('\0');
  if (!scope) return undefined;
  return { scope: pinScope({ scope, origin }, branchFiles), value };
}

const CREDENTIAL_KEY = /^credential\.(?:(.+)\.)?username$/;

/**
 * The scope that supplies `value` as the credential username for `url`. `git config
 * --show-scope --get-urlmatch` names the scope only from git 2.42 on; older git, such
 * as the runner's Debian bookworm, prints `unknown` (#1332). So every host finds the
 * scope the same way: among the scoped `credential.*username` entries, the last whose
 * URL pattern covers `url` and whose value is `value`. A pattern this does not
 * recognise (git's host wildcards) reads as `unrecognised`, which the hook refuses.
 * Order, not git's most-specific-URL rule, picks among covering entries: they all
 * carry the same username, so any pinned one already vouches for it.
 *
 * @param {{ scope: string, key: string, value: string }[]} entries in git's reading order
 * @returns {{ scope: string, value: string } | undefined}
 */
export function credentialUsername(entries, value, url) {
  if (!value) return undefined;
  const covers = (pattern) => {
    if (pattern === undefined) return true;
    const prefix = pattern.replace(/\/+$/, '').toLowerCase();
    const target = url.toLowerCase();
    return target === prefix || target.startsWith(`${prefix}/`);
  };
  const source = entries.findLast((entry) => {
    const match = CREDENTIAL_KEY.exec(entry.key);
    return match && entry.value === value && covers(match[1]);
  });
  return { scope: source?.scope ?? 'unrecognised', value };
}

/** NUL-delimited, as `scope\0origin\0key\nvalue\0`, so a URL with a space or an empty value parses whole. */
function scopedCredentialEntries(branchFiles) {
  const fields = git(['config', '--null', '--show-scope', '--show-origin', '--get-regexp', '^credential\\..*username$']).split('\0');
  const entries = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const scope = pinScope({ scope: fields[i], origin: fields[i + 1] }, branchFiles);
    const record = fields[i + 2], newline = record.indexOf('\n');
    entries.push(newline < 0
      ? { scope, key: record, value: '' }
      : { scope, key: record.slice(0, newline), value: record.slice(newline + 1) });
  }
  return entries;
}

const ZERO = /^0+$/;

/** Pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
function parseUpdates(input) {
  return input.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .filter(([, localSha, remoteRef]) => localSha && remoteRef)
    .map(([, localSha, remoteRef]) => ({ localSha, remoteRef }));
}

function pushedCommits(remote, updates) {
  const commits = [];
  for (const { localSha } of updates) {
    if (ZERO.test(localSha)) continue; // deletions push no commits
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
  const branchFiles = branchIncludeFiles();
  const updates = parseUpdates(readFileSync(0, 'utf8'));
  const problems = checkPush({
    remote,
    // A path remote has no URL to match and takes no credentials; it reads as unset.
    username: url?.includes('://')
      ? credentialUsername(scopedCredentialEntries(branchFiles), git(['config', '--get-urlmatch', 'credential.username', url]), url)
      : undefined,
    name: scoped('user.name', branchFiles),
    email: scoped('user.email', branchFiles),
    commits: pushedCommits(remote, updates),
    refs: updates.map((update) => update.remoteRef),
  });
  if (problems.length === 0) return 0;
  console.error('pre-push: refusing to push to forgejo as an unpinned or mismatched identity (docs/34):');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('Work on your own <agent>/ branch, whose identity the onbranch include supplies (docs/34.1), or pin it in config.worktree, then retry. Do not bypass this.');
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
