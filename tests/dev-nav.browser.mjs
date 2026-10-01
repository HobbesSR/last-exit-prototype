import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createArenaServer } from '../server/index.js';
import { listen } from './helpers/listen.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const replayDir = await mkdtemp(path.join(tmpdir(), 'last-exit-nav-browser-'));
const previousMapgenPort = process.env.MAPGEN_PORT;
const game = await createArenaServer({ replayDir, profileSummary: false });
const mapgenProcesses = [];
let browser;

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

try {
  const gameUrl = await listen(game);
  const gamePort = game.http.address().port;
  const mapgen = startMapgen(gamePort);
  mapgenProcesses.push(mapgen.child);
  const mapgenPort = await mapgen.ready;
  const mapgenUrl = `http://127.0.0.1:${mapgenPort}`;
  process.env.MAPGEN_PORT = String(mapgenPort);

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [pageUrl, linkedUrl] of [[`${gameUrl}/micro-lab.html`, mapgenUrl], [mapgenUrl, gameUrl]]) {
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    const nav = page.locator('.global-tool-nav');
    await nav.waitFor();
    assert.equal(await nav.locator(`a[href="${linkedUrl}/"]`).count(), 1);
    assert.equal(await nav.evaluate(element => getComputedStyle(element).display), 'flex');
    await page.close();
  }
  console.log('Dev navigation browser checks passed for the game and Map Lab.');
} finally {
  if (previousMapgenPort === undefined) delete process.env.MAPGEN_PORT;
  else process.env.MAPGEN_PORT = previousMapgenPort;
  await browser?.close();
  for (const child of mapgenProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
  await game.close();
  await rm(replayDir, { recursive: true, force: true });
}
