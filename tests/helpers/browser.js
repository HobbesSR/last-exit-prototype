import { chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createArenaServer } from '../../server/index.js';
import { listen } from './listen.js';
import { spawnEdge } from './edge.js';
import { buildCore } from '../../tools/build-core.mjs';

/**
 * An arena server on an ephemeral loopback port, its `last-exit-edge` process (unless `edge: false`),
 * and the headless Chrome the browser scripts drive it with. close() disposes browser, edge, and server.
 * The core is built first: the server's games and the client's scene both load it (docs/27).
 */
export async function serveWithBrowser(options = {}) {
  buildCore();
  const { edge: withEdge = true, ...serverOptions } = options;
  const server = await createArenaServer({ strictProtocol: true, ...serverOptions });
  let edge = null;
  try {
    const base = await listen(server);
    if (withEdge) {
      edge = await spawnEdge(server);
      // Most browser scripts close `server` directly instead of calling `close()`.
      const stopServer = server.close.bind(server);
      server.close = async () => { try { await edge.stop(); } finally { await stopServer(); } };
    }
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    return { server, base, browser, async close() {
      try { await browser.close(); } finally { await server.close(); }
    } };
  } catch (error) {
    try { await edge?.stop(); } catch (cleanupError) { console.error('Edge cleanup failed:', cleanupError); }
    try { await server.close(); } catch (cleanupError) { console.error('Browser setup cleanup failed:', cleanupError); }
    throw error;
  }
}

/** A development-tools server with temporary recordings owned by close(). */
export async function serveDevWithBrowser(options = {}) {
  const replayDir = await mkdtemp(path.join(tmpdir(), 'last-exit-browser-'));
  try {
    const session = await serveWithBrowser({ profileSummary: false, devTools: 'all', ...options, replayDir });
    return { ...session, replayDir, async close() {
      try { await session.close(); } finally { await rm(replayDir, { recursive: true, force: true }); }
    } };
  } catch (error) {
    try { await rm(replayDir, { recursive: true, force: true }); } catch (cleanupError) { console.error('Browser setup cleanup failed:', cleanupError); }
    throw error;
  }
}

/** Collect page errors and, when requested, console errors admitted by the caller's filter. */
export function collectBrowserErrors(page, errors, { consoleErrors = false } = {}) {
  page.on('pageerror', error => errors.push(error.message));
  if (consoleErrors) page.on('console', message => {
    if (message.type() === 'error' && (consoleErrors === true || consoleErrors(message.text()))) errors.push(message.text());
  });
}
