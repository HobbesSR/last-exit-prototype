import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { serveWithBrowser } from './helpers/browser.js';
import { createPhysicsMatch } from '../server/match.js';
import { contentById } from '../shared/simulation/content.ts';
import { SCHEMA } from '../shared/recording.ts';

const map = { seed: 446, width: 4000, height: 800,
  playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 40]] })) },
  modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
  chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
  entry: { x: 80, y: 400 }, exit: { x: 3900, y: 400 },
  spawns: [{ x: 250, y: 400 }, { x: 3000, y: 400 }], hunterSpawns: [{ x: 150, y: 400 }] };
const content = structuredClone(contentById('content-physics-6'));
content.roster = { contestants: ['Near', 'Far'], gladiators: [{ name: 'Caster', kit: 'hook' }] };
const replayDir = await mkdtemp(path.join(tmpdir(), 'last-exit-p6-live-'));
const { server, base, browser } = await serveWithBrowser({ replayDir, profileSummary: false,
  content: () => structuredClone(content), matchFactory: createPhysicsMatch,
  generateMap: () => structuredClone(map) });
try {
  const created = await (await fetch(`${base}/api/rooms`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: 446 }) })).json();
  await server.rooms.get(created.id).ready;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const result = await page.evaluate(async ({ base, room, ownerKey }) => {
    const { createLayerDecoder } = await import('/shared/frame-layers.ts');
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function until(check, label, ms = 6000) {
      const deadline = performance.now() + ms;
      while (performance.now() < deadline) { const value = check(); if (value) return value; await sleep(10); }
      throw new Error(`Timed out waiting for ${label}`);
    }
    async function connect(role, name, extra = {}) {
      const ws = new WebSocket(base.replace('http:', 'ws:'));
      const decoder = createLayerDecoder(), messages = [], frames = [];
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'state') frames.push(decoder.decode(message.state));
        messages.push(message);
      };
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      ws.send(JSON.stringify({ type: 'join', room, role, name, ...extra }));
      const welcome = await until(() => messages.find(message => message.type === 'welcome'), `${name} welcome`);
      return { ws, messages, frames, welcome };
    }
    const caster = await connect('gladiator', 'Caster', { kit: 'hook', ownerKey });
    const near = await connect('contestant', 'Near');
    const far = await connect('contestant', 'Far');
    try {
      if (caster.welcome.id === near.welcome.id || near.welcome.id === far.welcome.id) throw new Error('duplicate seats');
      caster.ws.send(JSON.stringify({ type: 'start' }));
      await until(() => [caster, near, far].every(client => client.frames.some(frame => frame.phase === 'live' && frame.tick === 0)), 'initial live state');
      caster.ws.send(JSON.stringify({ type: 'input', seq: 1, skill: true, aim: 0 }));
      const flight = await until(() => caster.frames.find(frame => frame.hookFlights?.length), 'flying hook');
      const attach = await until(() => caster.frames.find(frame => frame.tethers?.some(t => t.id === flight.hookFlights[0].id)), 'attached tether');
      const nearAtFlight = await until(() => near.frames.find(frame => frame.tick === flight.tick), 'near flight tick');
      const farAtFlight = await until(() => far.frames.find(frame => frame.tick === flight.tick), 'far flight tick');
      const farAtAttach = await until(() => far.frames.find(frame => frame.tick === attach.tick), 'far attach tick');
      caster.ws.send(JSON.stringify({ type: 'input', seq: 2, skill: true }));
      const cancelled = await until(() => caster.frames.find(frame => frame.tick > attach.tick &&
        !frame.tethers?.some(t => t.id === flight.hookFlights[0].id)), 'cancelled tether');
      caster.ws.send(JSON.stringify({ type: 'finish' }));
      await until(() => caster.messages.find(message => message.type === 'saved'), 'saved replay');
      return { ids: { caster: caster.welcome.id, near: near.welcome.id, far: far.welcome.id },
        contentIds: [caster.welcome.contentId, near.welcome.contentId, far.welcome.contentId],
        versions: [flight.version, attach.version],
        flight: { tick: flight.tick, hook: flight.hookFlights[0], body: flight.bodies.find(b => b.id === flight.hookFlights[0].a) },
        nearFlight: nearAtFlight.hookFlights,
        farFlight: farAtFlight?.hookFlights, farBodies: farAtFlight?.bodies.map(b => b.id),
        attach: { tick: attach.tick, tether: attach.tethers.find(t => t.id === flight.hookFlights[0].id), flights: attach.hookFlights },
        farAttach: { tethers: farAtAttach.tethers, flights: farAtAttach.hookFlights },
        cancelled: { tick: cancelled.tick, tethers: cancelled.tethers, flights: cancelled.hookFlights },
        stale: [...caster.frames, ...near.frames, ...far.frames].flatMap(frame => frame.stale || []) };
    } finally { for (const client of [caster, near, far]) client.ws.close(); }
  }, { base, room: created.id, ownerKey: created.ownerKey });
  assert.deepEqual(result.contentIds, ['content-physics-6', 'content-physics-6', 'content-physics-6']);
  assert.deepEqual(result.versions, ['last-exit-0.8-physics-6', 'last-exit-0.8-physics-6']);
  assert.equal(result.flight.hook.a, result.flight.body.id);
  assert.equal(result.flight.body.actorId, result.ids.caster);
  assert.ok(result.flight.hook.x > result.flight.body.x);
  assert.deepEqual(result.nearFlight, [result.flight.hook]);
  assert.deepEqual(result.farFlight, []);
  assert.equal(result.farBodies.includes(result.flight.hook.a), false);
  assert.deepEqual(result.attach.flights, []);
  assert.deepEqual([result.attach.tether.a, result.attach.tether.b],
    [`actor:${result.ids.caster}`, `actor:${result.ids.near}`]);
  assert.deepEqual(result.farAttach.tethers, []);
  assert.deepEqual(result.farAttach.flights, []);
  assert.deepEqual(result.cancelled.tethers, []);
  assert.deepEqual(result.cancelled.flights, []);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(errors, []);
  const replay = JSON.parse(gunzipSync(await readFile(path.join(replayDir, `${created.id}.json.gz`))));
  assert.equal(replay.version, 'last-exit-0.8-physics-6');
  assert.equal(replay.contentId, 'content-physics-6');
  assert.equal(replay.schema, SCHEMA);
  assert.equal(replay.minSchema, 10);
  assert.ok(replay.frames.some(frame => frame.state.hookFlights?.length), 'recording retains the flight display frame');
  console.log(JSON.stringify({ passed: true, browser: browser.version(), checks: [
    'real WebSocket flight', 'near/far projection privacy', 'next-tick tether', 'cancelled tether' ] }));
  await page.close();
} finally { await browser.close(); await server.close(); await rm(replayDir, { recursive: true, force: true }); }
