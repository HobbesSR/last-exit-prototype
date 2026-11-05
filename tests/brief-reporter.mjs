import path from 'node:path';
import os from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// A thin node:test reporter for agents, whose every line of test output is paid for in context.
// One line per test file (its name, how many top-level tests passed and its wall time), the name,
// location and error of each failure at any depth, and a closing count. Nothing else: no passing
// test names, no diagnostics, no captured output unless a file crashes outside any test. Run a
// test script through it with `npm run brief -- test` (tests/brief.mjs). People keep the spec
// reporter.
//
// Timing is recorded on every run at no cost in output (31, "Recorded test times"): each file's
// and each top-level test's duration go to test-results/test-times/<script>.json, which keeps the
// last RUNS_KEPT runs. The output adds only the slowest files and any file well above its recorded
// median. A failure to record never fails the run.
const MAX_NAME = 100, MAX_DETAIL_LINES = 12, MAX_STDERR_CHARS = 1 << 16;
export const RUNS_KEPT = 10, SLOWEST_SHOWN = 5;
/** A file is flagged when it takes this many times its median over at least MIN_HISTORY earlier runs, and this many seconds more. */
export const DRIFT_RATIO = 2, DRIFT_SECONDS = 3, MIN_HISTORY = 3;

// Events name a file inconsistently: relative for stderr and file-level tests, absolute otherwise.
const fileKey = file => path.resolve(file);
const isFileLevel = data => Boolean(data.file) && fileKey(data.name) === fileKey(data.file);
// A file's own completion is named by the file's base name (or its path, when it crashed).
const isFileCompletion = data => data.nesting === 0 && Boolean(data.file)
  && (data.name === path.basename(data.file) || isFileLevel(data));
const fileName = file => path.basename(file).replace(/\.test\.[cm]?[jt]s$/, '');
const relative = file => path.relative(process.cwd(), file).split(path.sep).join('/');
const seconds = ms => `${(ms / 1000).toFixed(1)}s`;

const indent = lines => lines.map(line => `     ${line}`).join('\n');

const label = data => {
  const name = data.name.length > MAX_NAME ? `${data.name.slice(0, MAX_NAME - 1)}…` : data.name;
  // A file that fails outside any test (an import crash) reports as a test named after its path.
  return !data.file ? name : isFileLevel(data) ? fileName(data.file) : `${fileName(data.file)} › ${name}`;
};

const errorLines = error => {
  const cause = error?.cause ?? error;
  return String(cause?.message ?? cause ?? 'failed').trim().split('\n').slice(0, MAX_DETAIL_LINES);
};

// The tail of a crashed file's stderr, without blank lines, node's own stack frames or the closing
// "Node.js vN" line.
const crashLines = text => (text ?? '').split('\n').map(line => line.trimEnd())
  .filter(line => line && !/^Node\.js v\d/.test(line) && !/^\s+at .*\(?node:internal\//.test(line))
  .slice(-MAX_DETAIL_LINES);

/** The median of `values`, or undefined for none. */
const median = values => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Files whose time this run is well above their median over earlier runs: at least DRIFT_RATIO
 * times it and DRIFT_SECONDS more, with MIN_HISTORY earlier readings. Slowest first.
 */
export function drifted(runs, files) {
  const flagged = [];
  for (const [file, ms] of Object.entries(files)) {
    const earlier = runs.map(run => run.files?.[file]).filter(Number.isFinite);
    const typical = median(earlier);
    if (earlier.length >= MIN_HISTORY && ms >= DRIFT_RATIO * typical && ms - typical >= DRIFT_SECONDS * 1000)
      flagged.push({ file, ms, median: typical, runs: earlier.length });
  }
  return flagged.sort((a, b) => b.ms - a.ms);
}

// The share of the machine's CPU time spent busy since `before` (this run's own tests included).
const cpuTimes = () => os.cpus().reduce((sum, cpu) => {
  const t = cpu.times, all = t.user + t.nice + t.sys + t.idle + t.irq;
  return { busy: sum.busy + all - t.idle, all: sum.all + all };
}, { busy: 0, all: 0 });
const busyShare = before => {
  const now = cpuTimes(), all = now.all - before.all;
  return all > 0 ? (now.busy - before.busy) / all : undefined;
};

/** Where runs of `script` are recorded: BRIEF_TIMES_DIR, or test-results/test-times. */
const recordPath = script => path.join(process.env.BRIEF_TIMES_DIR ?? path.join('test-results', 'test-times'),
  `${script.replace(/[^\w.-]+/g, '_')}.json`);
const readRuns = file => {
  try { const runs = JSON.parse(readFileSync(file, 'utf8')).runs; return Array.isArray(runs) ? runs : []; } catch { return []; }
};

export default async function* briefReporter(source) {
  const start = performance.now(), cpuStart = cpuTimes();
  const script = process.env.BRIEF_SCRIPT || 'adhoc';
  const totals = { ok: 0, fail: 0, skip: 0, todo: 0 };
  const stderr = new Map(); // file -> its recent stderr, shown only when the file crashes
  const fileMs = new Map(); // file key -> its wall time, from its file-level completion
  const testMs = new Map(); // file key -> { top-level test name: ms }
  // Skips and TODOs are not failures, whether or not a TODO's body fails (node exits 0 for both).
  const outcomeOf = (data, passed) => data.todo !== undefined ? 'todo' : data.skip !== undefined ? 'skip' : passed ? 'ok' : 'fail';
  const tally = counts => `${counts.ok} ok${counts.fail ? `, ${counts.fail} failed` : ''}${counts.skip ? `, ${counts.skip} skipped` : ''}${counts.todo ? `, ${counts.todo} todo` : ''}`;
  // The runner reports each file's results together, then the file's own completion; a file's
  // line is written when the next file's results begin, or at the end.
  let current = null;
  const fileLine = () => {
    if (!current) return '';
    const ms = fileMs.get(current.key);
    const line = `${current.fail ? 'FAIL' : 'ok  '} ${fileName(current.file)}  ${tally(current)}${ms === undefined ? '' : `  ${seconds(ms)}`}\n`;
    current = null;
    return line;
  };
  const count = (data, outcome) => {
    if (data.nesting !== 0) return '';
    const key = data.file ? fileKey(data.file) : '';
    const flushed = current && current.key !== key ? fileLine() : '';
    current ??= { key, file: data.file ?? '(no file)', ok: 0, fail: 0, skip: 0, todo: 0 };
    current[outcome]++;
    totals[outcome]++;
    return flushed;
  };
  for await (const event of source) {
    const { data } = event;
    if (event.type === 'test:stderr' && data.file) {
      const key = fileKey(data.file), text = (stderr.get(key) ?? '') + data.message;
      stderr.set(key, text.slice(-MAX_STDERR_CHARS));
    } else if (event.type === 'test:complete' && Number.isFinite(data.details?.duration_ms) && data.nesting === 0 && data.file) {
      const key = fileKey(data.file);
      if (isFileCompletion(data)) fileMs.set(key, data.details.duration_ms);
      else {
        const tests = testMs.get(key) ?? {};
        tests[data.name] = Math.round(data.details.duration_ms);
        testMs.set(key, tests);
      }
    } else if (event.type === 'test:diagnostic' && data.file) {
      // A diagnostic scoped to a file reports trouble outside any test's result, such as
      // asynchronous activity (often a late error) after a test ended. Run-wide counts have no file.
      yield `  ! ${fileName(data.file)}\n${indent(String(data.message).trim().split('\n').slice(0, MAX_DETAIL_LINES))}\n`;
    } else if (event.type === 'test:pass') {
      const flushed = count(data, outcomeOf(data, true));
      if (flushed) yield flushed;
    } else if (event.type === 'test:fail') {
      const outcome = outcomeOf(data, false);
      const flushed = count(data, outcome);
      if (flushed) yield flushed;
      // Only the leaves carry the real error; a parent fails with "N subtests failed".
      if (outcome !== 'fail' || data.details?.error?.failureType === 'subtestsFailed') continue;
      const where = data.file ? ` (${path.relative(process.cwd(), data.file)}${data.line ? `:${data.line}` : ''})` : '';
      const crash = isFileLevel(data) ? crashLines(stderr.get(fileKey(data.file))) : [];
      yield `  ✖ ${label(data)}${where}\n${indent(crash.length ? crash : errorLines(data.details?.error))}\n`;
    }
  }
  const last = fileLine();
  if (last) yield last;
  const wall = performance.now() - start, busy = busyShare(cpuStart);
  const files = Object.fromEntries([...fileMs].map(([key, ms]) => [relative(key), Math.round(ms)]));

  const ranked = Object.entries(files).sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1) yield `slowest: ${ranked.slice(0, SLOWEST_SHOWN).map(([file, ms]) => `${fileName(file)} ${seconds(ms)}`).join(', ')}\n`;
  const record = recordPath(script), runs = readRuns(record);
  const load = busy === undefined ? '' : `; machine ${Math.round(100 * busy)}% busy, this run included`;
  for (const flag of drifted(runs, files))
    yield `slower: ${fileName(flag.file)} ${seconds(flag.ms)}, median ${seconds(flag.median)} over ${flag.runs} runs${load}\n`;
  try {
    const run = { at: new Date().toISOString(), script, wallMs: Math.round(wall), cpus: os.cpus().length,
      busy: busy === undefined ? null : Math.round(100 * busy) / 100, files,
      tests: Object.fromEntries([...testMs].map(([key, tests]) => [relative(key), tests])) };
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(record, `${JSON.stringify({ runs: [...runs, run].slice(-RUNS_KEPT) })}\n`);
  } catch {
    // Recording is a convenience: an unwritable directory leaves the run's result as it was.
  }
  yield `${totals.fail ? 'FAILED' : 'passed'}: ${totals.ok} ok, ${totals.fail} failed, ${totals.skip} skipped${totals.todo ? `, ${totals.todo} todo` : ''}, ${seconds(wall)}\n`;
}
