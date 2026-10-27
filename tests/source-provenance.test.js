import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSourceProvenance } from '../tools/lib/source-provenance.mjs';

test('provenance pins committed bytes and accepts only line-ending changes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'source-provenance-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  try {
    git('init');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'core.autocrlf', 'false');
    await writeFile(join(cwd, 'source.txt'), 'one\ntwo\nthree\n');
    git('add', 'source.txt');
    git('commit', '-m', 'fixture');
    const original = await captureSourceProvenance(['source.txt'], { cwd });
    assert.equal(original.sourceSha256['source.txt'], createHash('sha256').update('one\ntwo\nthree\n').digest('hex'));
    for (const text of ['one\r\ntwo\r\nthree\r\n', 'one\r\ntwo\nthree\r\n']) {
      await writeFile(join(cwd, 'source.txt'), text);
      const result = await captureSourceProvenance(['source.txt'], { cwd });
      assert.equal(result.commit, original.commit);
      assert.deepEqual(result.sourceSha256, original.sourceSha256);
      assert.deepEqual(result.sourceGitBlob, original.sourceGitBlob);
      assert.equal(result.sourceWorkingTreeSha256['source.txt'], createHash('sha256').update(text).digest('hex'));
    }
    await writeFile(join(cwd, 'source.txt'), 'one\ntwo\nchanged\n');
    await assert.rejects(captureSourceProvenance(['source.txt'], { cwd }), /differs substantively/);
    await writeFile(join(cwd, 'untracked.txt'), 'new');
    await assert.rejects(captureSourceProvenance(['untracked.txt'], { cwd }), /missing or untracked/);
    await rm(join(cwd, 'source.txt'));
    await assert.rejects(captureSourceProvenance(['source.txt'], { cwd }), /Cannot read working source/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
