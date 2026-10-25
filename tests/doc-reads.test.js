import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, summarize, report, shellKind } from '../tools/doc-reads.mjs';

const call = (id, name, input, ts = '2026-10-20T00:00:00Z') => ({ timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content) => ({ message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

const lines = [
  call('a', 'Read', { file_path: 'C:\\repo\\docs\\54-region-types.md' }),
  result('a', 'x'.repeat(4000)),
  call('b', 'Bash', { command: 'sed -n 1,80p docs/20.3-builders-decomposition.md docs/54-region-types.md' }),
  result('b', [{ type: 'text', text: 'y'.repeat(1000) }]),
  call('c', 'Bash', { command: "sed -i 's/a/b/' docs/54-region-types.md" }),
  result('c', ''),
  call('d', 'Grep', { pattern: 'cover', path: 'docs/54-region-types.md' }, '2026-10-01T00:00:00Z'),
  result('d', 'z'.repeat(200)),
  call('e', 'Read', { file_path: 'src/main.ts' }),
  result('e', 'w'.repeat(9000)),
];

test('shell commands are classified by how they read, and writes are skipped', () => {
  assert.equal(shellKind('sed -n 10,40p docs/14-match-rules.md'), 'shell-range');
  assert.equal(shellKind('cat docs/14-match-rules.md'), 'shell-full');
  assert.equal(shellKind('Get-Content docs/14-match-rules.md'), 'shell-full');
  assert.equal(shellKind('grep -n cover docs/54-region-types.md'), 'grep');
  assert.equal(shellKind('git diff docs/54-region-types.md'), null);
  assert.equal(shellKind('echo hi > docs/x.md'), null);
});

test('collect keeps only doc reads, with their result sizes', () => {
  const recs = [...collect(lines, 's1').values()];
  assert.deepEqual(recs.map((r) => r.kind), ['read-full', 'shell-range', 'grep']);
  assert.deepEqual(recs[1].docs, ['20.3-builders-decomposition.md', '54-region-types.md']);
  assert.equal(recs[1].chars, 1000);
});

test('a call naming two docs splits its size; since drops earlier reads', () => {
  const seen = collect(lines, 's1');
  collect(lines, 's2', seen); // a resumed transcript repeats the same calls
  const all = summarize([...seen.values()]);
  assert.equal(all.get('54-region-types.md').chars, 4000 + 500 + 200);
  assert.equal(all.get('54-region-types.md').sessions.size, 1);
  assert.equal(summarize([...seen.values()], '2026-10-10').get('54-region-types.md').chars, 4500);
});

test('report ranks docs by characters read', () => {
  const text = report([...collect(lines, 's1').values()]);
  assert.match(text.split('\n')[2], /^54-region-types\.md\s+1\s+5\s+[\d.]+\s+1\/1\/1/);
});
