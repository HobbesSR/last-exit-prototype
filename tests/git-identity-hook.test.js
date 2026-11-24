import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPush, credentialUsername, pinScope } from '../tools/git-hooks/pre-push.mjs';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'git-hooks');
const pinned = (value, scope = 'worktree') => ({ scope, value });
const agent = {
  remote: 'forgejo',
  username: pinned('agent-codex'),
  name: pinned('agent-codex'),
  email: pinned('codex@local.host'),
  commits: [{ sha: 'abc1234', committerEmail: 'codex@local.host' }],
};

test('a worktree- or environment-pinned agent identity may push its own commits', () => {
  assert.deepEqual(checkPush(agent), []);
  assert.deepEqual(checkPush({ ...agent, username: pinned('agent-codex', 'command'), email: pinned('codex@local.host', 'command') }), []);
});

test('identity inherited from shared config, or missing, is refused', () => {
  assert.match(checkPush({ ...agent, username: undefined }).join('\n'), /credential username is not set/);
  assert.match(checkPush({ ...agent, name: pinned('agent-claudecode', 'local') }).join('\n'), /user.name \(agent-claudecode\) comes from local config/);
  assert.match(checkPush({ ...agent, email: pinned('x@y', 'global') }).join('\n'), /user.email .* comes from global config/);
});

test('an agent account must push under its own name, and only its own commits', () => {
  assert.match(checkPush({ ...agent, name: pinned('agent-hermes') }).join('\n'), /does not match user.name agent-hermes/);
  const foreign = Array.from({ length: 7 }, (_, i) => ({ sha: `f${i}`, committerEmail: 'someone@else' }));
  const problems = checkPush({ ...agent, commits: [...agent.commits, ...foreign] });
  assert.equal(problems.length, 6);
  assert.match(problems.at(-1), /2 more commits/);
});

test('an agent account may push only its own namespace; the human may push any', () => {
  assert.deepEqual(checkPush({ ...agent, refs: ['refs/heads/codex/fix', 'refs/heads/codex/old'] }), []);
  const problems = checkPush({ ...agent, refs: ['refs/heads/codex/fix', 'refs/heads/claudecode/fix', 'refs/heads/codexish', 'refs/tags/v1'] });
  assert.deepEqual(problems.map((problem) => problem.split(' not ')[1]), ['refs/heads/claudecode/fix.', 'refs/heads/codexish.', 'refs/tags/v1.']);
  const human = { ...agent, username: pinned('corey'), name: pinned('HobbesSR'), email: pinned('codex@local.host') };
  assert.deepEqual(checkPush({ ...human, refs: ['refs/heads/codex/fix'] }), []);
});

test('local config counts as the branch identity only when read from an onbranch include', () => {
  const files = new Set(['c:/home/.config/git/agents/codex.inc']);
  assert.equal(pinScope({ scope: 'local', origin: 'file:C:/home/.config/git/agents/codex.inc' }, files), 'branch');
  assert.equal(pinScope({ scope: 'local', origin: 'file:C:/repo/.git/config' }, files), 'local');
  assert.equal(pinScope({ scope: 'global', origin: 'file:C:/home/.config/git/agents/codex.inc' }, files), 'global');
});

test('the credential username takes the scope of the last entry that covers the URL with its value', () => {
  const url = 'http://forge:3000/corey/repo.git';
  const entry = (scope, key, value = 'agent-codex') => ({ scope, key, value });
  assert.equal(credentialUsername([], '', url), undefined);
  assert.deepEqual(credentialUsername([entry('global', 'credential.username'), entry('worktree', 'credential.http://forge:3000/.username')], 'agent-codex', url),
    { scope: 'worktree', value: 'agent-codex' });
  // A pin for another URL, or with another value, does not vouch for this one.
  assert.equal(credentialUsername([entry('global', 'credential.username'), entry('worktree', 'credential.http://forge:3000/other.username')], 'agent-codex', url).scope, 'global');
  assert.equal(credentialUsername([entry('global', 'credential.username'), entry('worktree', 'credential.username', 'agent-hermes')], 'agent-codex', url).scope, 'global');
  assert.equal(credentialUsername([entry('worktree', 'credential.http://*:3000.username')], 'agent-codex', url).scope, 'unrecognised');
});

test('the installed hook blocks an unpinned push and allows a pinned one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'identity-hook-'));
  // Isolate from the developer's own git config and environment-injected identity.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, 'none'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' };
  const git = (...args) => spawnSync('git', ['-C', path.join(dir, 'work'), ...args], { encoding: 'utf8', env });
  const remote = pathToFileURL(path.join(dir, 'remote.git')).href;
  try {
    spawnSync('git', ['init', '-q', '--bare', path.join(dir, 'remote.git')], { env });
    spawnSync('git', ['init', '-q', path.join(dir, 'work')], { env });
    git('config', 'core.hooksPath', HOOKS);
    git('config', 'extensions.worktreeConfig', 'true');
    git('config', 'user.name', 'agent-claudecode'); // the shared fallback the hook must not accept
    git('config', 'user.email', 'claudecode@local.host');
    git('remote', 'add', 'forgejo', remote);
    git('commit', '-q', '--allow-empty', '-m', 'first');

    const refused = git('push', '-q', 'forgejo', 'HEAD:refs/heads/a');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /user.name \(agent-claudecode\) comes from local config/);

    git('config', '--worktree', 'user.name', 'agent-claudecode');
    git('config', '--worktree', 'user.email', 'claudecode@local.host');
    git('config', '--worktree', `credential.${remote}.username`, 'agent-claudecode');
    const allowed = git('push', '-q', 'forgejo', 'HEAD:refs/heads/claudecode/a');
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(git('push', '-q', 'forgejo', 'HEAD:refs/heads/a').stderr, /may push only refs\/heads\/claudecode\/\*/);

    // Without worktree pins, the checked-out branch's namespace supplies the identity.
    git('config', '--worktree', '--remove-section', 'user');
    git('config', '--worktree', '--remove-section', `credential.${remote}`);
    const include = path.join(dir, 'claudecode.inc').replaceAll('\\', '/');
    writeFileSync(include, `[user]\n\tname = agent-claudecode\n\temail = claudecode@local.host\n[credential "${remote}"]\n\tusername = agent-claudecode\n`);
    git('config', 'includeIf.onbranch:claudecode/**.path', include);
    assert.match(git('push', '-q', 'forgejo', 'HEAD:refs/heads/claudecode/b').stderr, /credential username is not set/);
    git('switch', '-q', '-c', 'claudecode/b');
    const byBranch = git('push', '-q', 'forgejo', 'HEAD:refs/heads/claudecode/b');
    assert.equal(byBranch.status, 0, byBranch.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
