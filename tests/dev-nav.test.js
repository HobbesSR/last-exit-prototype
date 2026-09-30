import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createArenaServer } from '../server/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function startMapgen(gamePort) {
  const child = spawn(process.execPath, ['tools/server.mts', '--port', '0'], {
    cwd: path.join(root, 'map/macro'),
    env: { ...process.env, PORT: String(gamePort), MAPGEN_PORT: '4120' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Map Lab did not start')), 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Map Lab exited: ${code}`)); });
  });
  return { child, ready };
}

test('dev navigation only links to the live peer in this worktree', async () => {
  const replayDir = await mkdtemp(path.join(tmpdir(), 'last-exit-nav-'));
  const previousMapgenPort = process.env.MAPGEN_PORT;
  const game = await createArenaServer({ replayDir, profileSummary: false });
  const mapgenProcesses = [];
  try {
    await new Promise(resolve => game.http.listen(0, '127.0.0.1', resolve));
    const gamePort = game.http.address().port;
    const mapgen = startMapgen(gamePort);
    mapgenProcesses.push(mapgen.child);
    const mapgenPort = await mapgen.ready;
    const gameUrl = `http://127.0.0.1:${gamePort}`;
    const mapgenUrl = `http://127.0.0.1:${mapgenPort}`;

    process.env.MAPGEN_PORT = String(mapgenPort);
    const gameNav = await (await fetch(`${gameUrl}/dev-nav.js`)).text();
    const mapgenNav = await (await fetch(`${mapgenUrl}/dev-nav.js`)).text();
    assert.match(gameNav, new RegExp(`http://127\\.0\\.0\\.1:${mapgenPort}`));
    assert.match(mapgenNav, new RegExp(`http://127\\.0\\.0\\.1:${gamePort}`));

    process.env.MAPGEN_PORT = '0';
    const unknownMapgen = await (await fetch(`${gameUrl}/dev-nav.js`)).text();
    assert.match(unknownMapgen, /renderDevNav\("http:\/\/127\.0\.0\.1:\d+", null\)/);

    // A CLI --port override can leave MAPGEN_PORT pointing at a different port.
    process.env.MAPGEN_PORT = '1';
    const overriddenMapgen = await (await fetch(`${gameUrl}/dev-nav.js`)).text();
    assert.match(overriddenMapgen, /renderDevNav\("http:\/\/127\.0\.0\.1:\d+", null\)/);

    const unknownGame = startMapgen(0);
    mapgenProcesses.push(unknownGame.child);
    const unknownGamePort = await unknownGame.ready;
    const unknownGameNav = await (await fetch(`http://127.0.0.1:${unknownGamePort}/dev-nav.js`)).text();
    assert.match(unknownGameNav, /renderDevNav\(null, "http:\/\/127\.0\.0\.1:\d+"\)/);
  } finally {
    if (previousMapgenPort === undefined) delete process.env.MAPGEN_PORT;
    else process.env.MAPGEN_PORT = previousMapgenPort;
    for (const child of mapgenProcesses) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
      }
    }
    await game.close();
    await rm(replayDir, { recursive: true, force: true });
  }
});
