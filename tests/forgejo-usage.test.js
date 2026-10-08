import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, summarize, report } from '../tools/forgejo-usage.mjs';

const call = (id, name, ts) => ({ timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const result = (id, content) => ({ message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

const lines = [
  call('a', 'mcp__forgejo__get_issue_details', '2026-10-01T00:00:00Z'),
  result('a', 'x'.repeat(8000)),
  call('b', 'mcp__forgejo__get_issue_details', '2026-10-09T00:00:00Z'),
  result('b', [{ type: 'text', text: 'y'.repeat(400) }, { type: 'image' }]),
  call('c', 'Read', '2026-10-09T00:00:00Z'),
  result('c', 'z'.repeat(100)),
  call('d', 'mcp__forgejo__create_comment', '2026-10-09T00:00:00Z'), // no result yet
];

test('collect pairs calls with result sizes, counting text parts only', () => {
  const recs = [...collect(lines).values()];
  assert.equal(recs.find((r) => r.name === 'Read').chars, 100);
  assert.equal(recs.filter((r) => r.chars === 400).length, 1);
  assert.equal(recs.find((r) => r.name.endsWith('create_comment')).chars, null);
});

test('a call repeated across resumed transcripts is counted once', () => {
  const seen = collect(lines);
  collect(lines, seen);
  assert.equal(seen.size, 4);
});

test('summarize separates forgejo tools from everything else and ignores unanswered calls', () => {
  const s = summarize([...collect(lines).values()]);
  assert.deepEqual(s.tools.get('mcp__forgejo__get_issue_details'), { calls: 2, chars: 8400 });
  assert.equal(s.tools.has('mcp__forgejo__create_comment'), false);
  assert.deepEqual(s.other, { calls: 1, chars: 100 });
});

test('report with a split compares average size before and after', () => {
  const text = report([...collect(lines).values()], '2026-10-05');
  assert.match(text, /get_issue_details\s+1 \/ 1\s+8000 \/ 400\s+-95%/);
});
