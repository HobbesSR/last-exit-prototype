import { chromium } from '@playwright/test';
import { createArenaServer } from '../../server/index.js';
import { listen } from './listen.js';

/**
 * An arena server on an ephemeral loopback port, and the headless Chrome the browser scripts
 * drive it with. Callers close both, browser first.
 */
export async function serveWithBrowser(options) {
  const server = await createArenaServer(options);
  const base = await listen(server);
  return { server, base, browser: await chromium.launch({ channel: 'chrome', headless: true }) };
}
