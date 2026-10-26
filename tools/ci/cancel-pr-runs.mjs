// Cancels the CI runs still queued or running for a pull request that was merged or closed
// (docs/31). Forgejo cancels a branch's older runs when it gets a new push, but not when its
// pull request merges, and those leftovers hold runner slots ahead of main's run.
// CI runs it on close: node tools/ci/cancel-pr-runs.mjs --pr=<number> [--dry-run=1]
import { pathToFileURL } from 'node:url';
import { options } from '../options.mjs';

const ACTIVE = ['waiting', 'running', 'blocked'];
const PAGE = 50;

/**
 * Every active `ci.yml` run of this pull request, reading `page(n)` (one page of active
 * `ci.yml` runs, newest first) until a short page. The server's `event` filter is not used:
 * it leaves out runs from `synchronized` pushes, which are exactly the leftovers.
 */
export async function activeRuns(page, pr) {
  const found = [];
  for (let n = 1; ; n++) {
    const runs = await page(n);
    found.push(...runs.filter(run => run.event === 'pull_request' && run.prettyref === `#${pr}` && ACTIVE.includes(run.status)));
    if (runs.length < PAGE) return found;
  }
}

async function main() {
  const args = options(process.argv.slice(2), ['pr', 'dry-run'], argument => `unknown option ${argument}`);
  const pr = args.get('pr');
  if (!/^\d+$/.test(pr ?? '')) throw new Error('usage: node tools/ci/cancel-pr-runs.mjs --pr=<number> [--dry-run=1]');
  const env = name => { const value = process.env[name]; if (!value) throw new Error(`${name} is not set`); return value; };
  const api = `${env('GITHUB_SERVER_URL').replace(/\/$/, '')}/api/v1/repos/${env('GITHUB_REPOSITORY')}/actions/runs`;
  const headers = { Authorization: `token ${env('FORGEJO_TOKEN')}` };
  const query = `workflow_id=ci.yml&${ACTIVE.map(status => `status=${status}`).join('&')}&limit=${PAGE}`;
  const runs = await activeRuns(async n => {
    const response = await fetch(`${api}?${query}&page=${n}`, { headers });
    if (!response.ok) throw new Error(`GET runs page ${n}: ${response.status} ${await response.text()}`);
    return (await response.json()).workflow_runs ?? [];
  }, pr);
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
