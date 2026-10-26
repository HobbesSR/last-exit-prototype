// Cancels the CI runs still queued or running for a pull request that was merged or closed
// (docs/31). Forgejo cancels a branch's older runs when it gets a new push, but not when its
// pull request merges, and those leftovers hold runner slots ahead of main's run.
// CI runs it on close: node tools/ci/cancel-pr-runs.mjs --pr=<number> [--dry-run=1]
import { pathToFileURL } from 'node:url';
import { options } from '../options.mjs';

const ACTIVE = new Set(['waiting', 'running', 'blocked']);

/** The runs to cancel: active `ci.yml` runs of this pull request. Never this workflow's own. */
export function runsToCancel(runs, pr) {
  return runs.filter(run => run.workflow_id === 'ci.yml' && run.event === 'pull_request' && run.prettyref === `#${pr}` && ACTIVE.has(run.status));
}

async function main() {
  const args = options(process.argv.slice(2), ['pr', 'dry-run'], argument => `unknown option ${argument}`);
  const pr = args.get('pr');
  if (!/^\d+$/.test(pr ?? '')) throw new Error('usage: node tools/ci/cancel-pr-runs.mjs --pr=<number> [--dry-run=1]');
  const env = name => { const value = process.env[name]; if (!value) throw new Error(`${name} is not set`); return value; };
  const api = `${env('GITHUB_SERVER_URL').replace(/\/$/, '')}/api/v1/repos/${env('GITHUB_REPOSITORY')}/actions/runs`;
  const headers = { Authorization: `token ${env('FORGEJO_TOKEN')}` };
  const response = await fetch(`${api}?event=pull_request&limit=50`, { headers });
  if (!response.ok) throw new Error(`GET runs: ${response.status} ${await response.text()}`);
  const runs = runsToCancel((await response.json()).workflow_runs, pr);
  if (!runs.length) console.log(`no active CI runs for #${pr}`);
  for (const run of runs) {
    if (!args.has('dry-run')) {
      const cancelled = await fetch(`${api}/${run.id}/cancel`, { method: 'POST', headers });
      if (!cancelled.ok) throw new Error(`cancel run ${run.id}: ${cancelled.status} ${await cancelled.text()}`);
    }
    console.log(`${args.has('dry-run') ? 'would cancel' : 'cancelled'} run ${run.id} (${run.status}): ${run.title}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
