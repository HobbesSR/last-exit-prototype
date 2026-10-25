import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { createArenaServer } from '../server/index.js';
import { listen } from './helpers/listen.js';

test('HTTP JSON accepts plain bodies and rejects compressed or invalid bodies', async () => {
  const replayDir = await mkdtemp(path.join(tmpdir(), 'last-exit-http-json-'));
  // The profile endpoint reads JSON but never creates a room or generates a map.
  const server = await createArenaServer({ replayDir, generateMap: async () => { throw new Error('unexpected map generation'); } });
  try {
    const base = await listen(server);
    const post = (body, encoding) => fetch(base + '/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(encoding && { 'Content-Encoding': encoding }) },
      body,
    });
    const plain = Buffer.from('{"enabled":false}');
    const accepted = await post(plain);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { enabled: false });

    for (const [encoding, compress] of [
      ['gzip', gzipSync],
      ['deflate', deflateSync],
      ['br', brotliCompressSync],
    ]) {
      const response = await post(compress(plain), encoding);
      assert.equal(response.status, 415, `${encoding} request body`);
    }
    // A valid gzip JSON body with bytes appended to the compressed stream is
    // still an encoded request and must be refused before parsing.
    const trailing = await post(Buffer.concat([gzipSync(plain), Buffer.from(' trailing')]), 'gzip');
    assert.equal(trailing.status, 415, 'compressed JSON with trailing bytes');
    assert.equal((await post(plain, 'compress')).status, 415, 'unsupported content encoding');

    assert.equal((await post('{"enabled":')).status, 400, 'malformed JSON');
    assert.equal((await post(JSON.stringify({ padding: 'x'.repeat(2048) }))).status, 413, 'plain JSON beyond 2kb');

    const afterRejections = await post(plain);
    assert.equal(afterRejections.status, 200, 'later normal request still works');
    assert.deepEqual(await afterRejections.json(), { enabled: false });
  } finally {
    await server.close();
    await rm(replayDir, { recursive: true, force: true });
  }
});
