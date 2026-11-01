import path from 'node:path';

// A thin node:test reporter for agents, whose every line of test output is paid for in context.
// One line per test file (its name and how many top-level tests passed), the name, location and
// error of each failure at any depth, and a closing count. Nothing else: no passing test names,
// no diagnostics, no captured output unless a file crashes outside any test. Run a test script
// through it with `npm run brief -- test` (tests/brief.mjs). People keep the spec reporter.
const MAX_NAME = 100, MAX_DETAIL_LINES = 12, MAX_STDERR_CHARS = 1 << 16;

// Events name a file inconsistently: relative for stderr and file-level tests, absolute otherwise.
const fileKey = file => path.resolve(file);
const isFileLevel = data => Boolean(data.file) && fileKey(data.name) === fileKey(data.file);
const fileName = file => path.basename(file).replace(/\.test\.[cm]?[jt]s$/, '');

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

export default async function* briefReporter(source) {
  const start = performance.now();
  const totals = { ok: 0, fail: 0, skip: 0 };
  const stderr = new Map(); // file -> its recent stderr, shown only when the file crashes
  // The runner reports each file's results together; a file's line is written when the next
  // file's results begin, or at the end.
  let current = null;
  const fileLine = () => {
    if (!current) return '';
    const { file, ok, fail, skip } = current;
    current = null;
    return `${fail ? 'FAIL' : 'ok  '} ${fileName(file)}  ${ok} ok${fail ? `, ${fail} failed` : ''}${skip ? `, ${skip} skipped` : ''}\n`;
  };
  const count = (data, outcome) => {
    if (data.nesting !== 0) return '';
    const key = data.file ? fileKey(data.file) : '';
    const flushed = current && current.key !== key ? fileLine() : '';
    current ??= { key, file: data.file ?? '(no file)', ok: 0, fail: 0, skip: 0 };
    current[outcome]++;
    totals[outcome]++;
    return flushed;
  };
  for await (const event of source) {
    const { data } = event;
    if (event.type === 'test:stderr' && data.file) {
      const key = fileKey(data.file), text = (stderr.get(key) ?? '') + data.message;
      stderr.set(key, text.slice(-MAX_STDERR_CHARS));
    } else if (event.type === 'test:pass') {
      const flushed = count(data, data.skip !== undefined || data.todo !== undefined ? 'skip' : 'ok');
      if (flushed) yield flushed;
    } else if (event.type === 'test:fail') {
      const flushed = count(data, 'fail');
      if (flushed) yield flushed;
      // Only the leaves carry the real error; a parent fails with "N subtests failed".
      if (data.details?.error?.failureType === 'subtestsFailed') continue;
      const where = data.file ? ` (${path.relative(process.cwd(), data.file)}${data.line ? `:${data.line}` : ''})` : '';
      const crash = isFileLevel(data) ? crashLines(stderr.get(fileKey(data.file))) : [];
      yield `  ✖ ${label(data)}${where}\n${indent(crash.length ? crash : errorLines(data.details?.error))}\n`;
    }
  }
  const last = fileLine();
  if (last) yield last;
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  yield `${totals.fail ? 'FAILED' : 'passed'}: ${totals.ok} ok, ${totals.fail} failed, ${totals.skip} skipped, ${seconds}s\n`;
}
