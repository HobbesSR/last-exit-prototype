import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { anchors, checkLinks, links, slug } from '../tools/check-doc-links.mjs';

test('slugs follow GitHub: punctuation dropped, spaces hyphenated, repeats suffixed', () => {
  assert.equal(slug('A test\'s cost is `part` of the change'), 'a-tests-cost-is-part-of-the-change');
  assert.equal(slug('Round 2: [the link](x.md) & **bold**'), 'round-2-the-link--bold');
  const { headings, ids } = anchors('# Same\n\n## Same ##\n\n```\n# not a heading\n```\n<a id="landing"></a>\n');
  assert.deepEqual([...headings], ['same', 'same-1']);
  assert.deepEqual([...ids], ['landing']);
});

test('links skips code, external URLs and Forgejo site paths, and keeps line numbers', () => {
  const text = [
    '[a](a.md#x) and `[no](code.md)` and [web](https://example.com/x.md)',
    '```',
    '[fenced](fenced.md)',
    '```',
    '[issue](/corey/astra_test/issues/1) [b](<b c.md> "title")',
    '[ref]: r.md#top',
  ].join('\n');
  assert.deepEqual(links(text), [
    { target: 'a.md#x', line: 1 },
    { target: 'b c.md', line: 5 },
    { target: 'r.md#top', line: 6 },
  ]);
});

test('checkLinks reports missing files and fragments with file and line, and treats the archive as its own island', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'doc-links-'));
  try {
    mkdirSync(path.join(dir, 'docs', 'archive', '2026-01-01-old'), { recursive: true });
    writeFileSync(path.join(dir, 'README.md'), '[ok](docs/a.md#top-heading) [bad](docs/missing.md)\n');
    writeFileSync(path.join(dir, 'docs', 'a.md'), '# Top heading\n\n[self](#top-heading) [bad](#nope) [id](b.md#land) [dir](archive/)\n');
    writeFileSync(path.join(dir, 'docs', 'b.md'), '<a id="land"></a>\n');
    writeFileSync(path.join(dir, 'docs', 'archive', '2026-01-01-old', 'README.md'),
      '[active gone](../../gone.md) [internal](x.md) [internal gone](y.md)\n');
    writeFileSync(path.join(dir, 'docs', 'archive', '2026-01-01-old', 'x.md'), 'x\n');
    const found = checkLinks(dir).map((p) => `${p.file}:${p.line} ${p.target}`).sort();
    assert.deepEqual(found, [
      'README.md:1 docs/missing.md',
      'docs/a.md:3 #nope',
      'docs/archive/2026-01-01-old/README.md:1 y.md',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every local link in the real docs resolves', () => {
  const broken = checkLinks().map((p) => `${p.file}:${p.line} ${p.target} (${p.problem})`);
  assert.deepEqual(broken, []);
});
