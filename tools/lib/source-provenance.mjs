import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = bytes => Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');

// Pin every canonical digest to one commit; checkout hashes remain separate evidence.
export async function captureSourceProvenance(paths, { cwd = process.cwd(), ref = 'HEAD' } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString('utf8').trim();
  const sourceSha256 = {}, sourceGitBlob = {}, sourceWorkingTreeSha256 = {};
  for (const path of paths) {
    let blob, blobId;
    try {
      blobId = git('rev-parse', '--verify', '--end-of-options', `${commit}:${path}`).toString('utf8').trim();
      if (git('cat-file', '-t', blobId).toString('utf8').trim() !== 'blob') throw new Error('not a blob');
      blob = git('cat-file', 'blob', blobId);
    } catch (error) {
      throw new Error(`Source ${path} is missing or untracked at commit ${commit}`, { cause: error });
    }
    let working;
    try { working = await readFile(resolve(cwd, path)); }
    catch (error) { throw new Error(`Cannot read working source ${path}`, { cause: error }); }
    if (!normalize(working).equals(normalize(blob)))
      throw new Error(`Working source ${path} differs substantively from commit ${commit}`);
    sourceSha256[path] = sha256(blob);
    sourceGitBlob[path] = blobId;
    sourceWorkingTreeSha256[path] = sha256(working);
  }
  return { commit, sourceSha256, sourceGitBlob, sourceWorkingTreeSha256 };
}
