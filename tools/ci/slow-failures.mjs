// Files the slow tier's failures on main as Forgejo issues (docs/31). CI runs it after a
// failed `npm run test:slow`: node tools/ci/slow-failures.mjs <log> [--dry-run=1]
// One open issue per failing test, found again by its exact title: a repeat failure is a
// comment on that issue rather than a new one.
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { options } from '../options.mjs';

const TITLE = 'Slow tier fails on main: ';
/** Past this many failures one cause is likely, so they share one issue. */
const MAX_ISSUES = 5;
const ERROR_LINES = 40;

/** The failing tests in node:test spec output: name, file and the start of the error. */
export function parseFailures(log) {
  const lines = log.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const start = lines.findIndex(line => /^✖ failing tests:/.test(line));
  if (start === -1) return [];
  const failures = [];
  let file = null;
  for (let i = start + 1; i < lines.length; i++) {
    const at = /^test at (.+?):\d+:\d+$/.exec(lines[i]);
    if (at) { file = at[1]; continue; }
    const failed = /^✖ (.+?) \([\d.]+m?s\)$/.exec(lines[i]);
    if (!failed) continue;
    const error = [];
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]) && error.length < ERROR_LINES; j++) error.push(lines[j]);
    failures.push({ name: failed[1], file, error: error.join('\n') });
    file = null;
  }
  return failures;
}

/** The issues to file or update, each with the title it is found by. */
export function plan(failures, { sha, runUrl }) {
  const footer = `\n\nCommit ${sha}, [run](${runUrl}). Filed by CI (docs/31): fix forward, and close this once the slow tier passes on main.`;
  const block = f => `\`${f.file ?? 'unknown file'}\`\n\n\`\`\`\n${f.error.trim() || '(no error output)'}\n\`\`\``;
  if (!failures.length) return [{ title: 'Slow tier job fails on main', body: `The slow job failed without a failing test: setup, a crash or a timeout. See the run log.${footer}` }];
  if (failures.length > MAX_ISSUES) {
    const list = failures.map(f => `- ${f.name} (\`${f.file ?? 'unknown file'}\`)`).join('\n');
    return [{ title: `${TITLE}${failures.length} tests`, body: `${failures.length} slow tests failed together, which suggests one cause:\n\n${list}\n\nFirst failure:\n\n${block(failures[0])}${footer}` }];
  }
  return failures.map(f => ({ title: `${TITLE}${f.name}`.slice(0, 255), body: `${block(f)}${footer}` }));
}

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) throw new Error('usage: node tools/ci/slow-failures.mjs <log> [--dry-run=1]');
  const dryRun = options(rest, ['dry-run'], argument => `unknown option ${argument}`).has('dry-run');
  const env = name => { const value = process.env[name]; if (!value) throw new Error(`${name} is not set`); return value; };
  const server = env('GITHUB_SERVER_URL').replace(/\/$/, ''), repo = env('GITHUB_REPOSITORY');
  const sha = env('GITHUB_SHA'), runUrl = `${server}/${repo}/actions/runs/${env('GITHUB_RUN_NUMBER')}`;
  const issues = plan(parseFailures(existsSync(file) ? readFileSync(file, 'utf8') : ''), { sha, runUrl });
  if (dryRun) { for (const issue of issues) console.log(`${issue.title}\n${issue.body}\n`); return; }

  const token = env('FORGEJO_TOKEN'), api = `${server}/api/v1/repos/${repo}`;
  const call = async (path, init = {}) => {
    const response = await fetch(`${api}${path}`, { ...init, headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  for (const issue of issues) {
    const found = await call(`/issues?state=open&type=issues&limit=50&q=${encodeURIComponent(issue.title)}`);
    const open = found.find(candidate => candidate.title === issue.title);
    if (open) {
      await call(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Still failing at ${sha}: [run](${runUrl}).` }) });
      console.log(`commented on #${open.number}: ${issue.title}`);
    } else {
      const created = await call('/issues', { method: 'POST', body: JSON.stringify(issue) });
      console.log(`filed #${created.number}: ${issue.title}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
