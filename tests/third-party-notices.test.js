import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NOTICES_FILE, readComponents, renderNotices } from '../tools/third-party-notices.mjs';
import { vendorPackages } from '../server/vendor-modules.js';
import { NOTICES_URL, VENDOR_DIRECTORIES, VENDOR_MODULES } from '../server/shared-assets.js';
import { createArenaServer } from '../server/index.js';
import { listen } from './helpers/listen.js';

const { components } = readComponents();
const byPackage = new Map(components.filter((item) => item.package).map((item) => [item.package, item]));
const installed = (name) => JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
const locked = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')).packages;

test('THIRD-PARTY-NOTICES.txt is what the components manifest renders', () => {
  assert.equal(fs.readFileSync(NOTICES_FILE, 'utf8').replace(/\r\n/g, '\n'), renderNotices(),
    'run `npm run notices` after changing tools/third-party/');
});

// A package the server starts delivering, or a version bump of one it delivers, has to be audited
// (docs/21.1) before this passes: the manifest names the version its notices were checked against.
test('every package the server delivers to a browser is audited at its installed version', () => {
  const delivered = new Map();
  for (const directory of Object.values(VENDOR_DIRECTORIES)) {
    const name = directory.startsWith('@') ? directory.split('/').slice(0, 2).join('/') : directory.split('/')[0];
    delivered.set(name, 'game');
  }
  for (const name of Object.keys(VENDOR_MODULES))
    for (const found of vendorPackages(name)) if (!delivered.has(found.name)) delivered.set(found.name, 'dev');
  for (const [name, delivery] of delivered) {
    const audited = byPackage.get(name);
    assert.ok(audited, `${name} is served but missing from tools/third-party/components.json`);
    assert.equal(audited.delivery, delivery, `${name} delivery`);
    assert.equal(installed(name), audited.version, `${name} installed version differs from the audited one`);
    assert.equal(locked[`node_modules/${name}`]?.version, audited.version, `${name} package-lock version`);
  }
  for (const name of byPackage.keys()) assert.ok(delivered.has(name), `${name} is audited but no longer served`);
});

test('the server delivers the notices to every client and the wrapped modules point to them', async () => {
  const replayDir = await mkdtemp(path.join(tmpdir(), 'notices-'));
  try {
    for (const devTools of ['none', 'all']) {
      const server = await createArenaServer({ devTools, replayDir, profileSummary: false });
      try {
        const base = await listen(server);
        const response = await fetch(`${base}${NOTICES_URL}`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/plain/);
        assert.equal((await response.text()).replace(/\r\n/g, '\n'), renderNotices());
        const page = await (await fetch(`${base}/`)).text();
        assert.ok(page.includes(`href="${NOTICES_URL}"`), 'the game page links the notices');
        if (devTools === 'all') {
          const wrapped = await (await fetch(`${base}${VENDOR_MODULES.pathfinding}`)).text();
          assert.match(wrapped.split('\n')[0], /pathfinding 0\.4\.18 \(MIT\), heap 0\.2\.5 \(PSF\).*\/third-party-notices\.txt/);
        }
      } finally { await server.close(); }
    }
  } finally { await rm(replayDir, { recursive: true, force: true }); }
});
