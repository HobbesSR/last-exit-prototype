// Serialize offline route-effect replay with other machine-wide measurements.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireMachineLock } from '../../../tests/helpers/machine-lock.js';
const [source, evidence, panel, effects, summary] = process.argv.slice(2);
if (!summary) throw Error('Usage: effects.mjs SOURCE EVIDENCE PANEL NEW_EFFECTS NEW_SUMMARY');
const lock = await acquireMachineLock('bench', { timeoutMs: 30 * 60_000, pollMs: 100 });
try {
  const result = spawnSync(process.execPath, ['tools/incidental-seam-effects.mjs', path.resolve(evidence, 'baseline-routes'), path.resolve(panel), path.resolve(panel), path.resolve(effects)], { cwd: path.resolve(source), stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw Error(`Effect replay failed: ${result.error ?? result.status}`);
  const summarized = spawnSync(process.execPath, ['docs/reports/issue-716-readiness/summarize.mjs', panel, effects, summary], { stdio: 'inherit', windowsHide: true });
  if (summarized.status !== 0) throw Error(`Summary failed: ${summarized.error ?? summarized.status}`);
} finally { lock.release(); }
