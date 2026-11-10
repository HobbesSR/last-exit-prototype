#!/usr/bin/env node
/**
 * The pregenerated room arena (#849): seed 9's live map at the default size with the shipped
 * content, and its portal graph, which room and networking tests play on instead of generating
 * one each (`tests/helpers/room-harness.js`). They test rooms, not maps; generation keeps its
 * own witnesses. `tests/slow/room-arena.test.js` checks the fixture against a fresh generation.
 *
 *   node tools/room-arena.mjs [--out=tests/fixtures/room-arena-9.v8.gz]
 *   node tools/room-arena.mjs --check[=FILE]
 *
 * The file is `v8.serialize({ map, graph })`, gzipped: the graph holds typed arrays, which JSON
 * drops. Recapture it after any change that moves seed 9's live map (a content batch, a builder
 * change, a field added to the map), as `--check` and the slow test report.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { generateLiveMap } from '../map/live.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { portalGraphOf } from '../shared/navigation/portal-graph.ts';

export const ARENA_SEED = 9;
export const ARENA_FILE = 'tests/fixtures/room-arena-9.v8.gz';

/** Seed 9's live map and portal graph, generated now. */
export function generateArena() {
  const map = generateLiveMap(ARENA_SEED, defaultContent());
  return { map, graph: portalGraphOf(map) };
}

/** The stored arena: a map and graph not shared with any other caller. */
export function readArena(file = ARENA_FILE) {
  return deserialize(gunzipSync(readFileSync(file)));
}

/** Whether the stored arena is the one generation gives now. */
export const arenaMatches = (stored, fresh = generateArena()) =>
  isDeepStrictEqual(stored.map, structuredClone(fresh.map)) && isDeepStrictEqual(stored.graph, structuredClone(fresh.graph));

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--(out|check)(?:=(.+))?$/.exec(arg);
    if (!match || (match[1] === 'out' && match[2] === undefined)) throw new Error('Use [--out=FILE] or --check[=FILE]');
    return [match[1], match[2] ?? true];
  }));
  if (args.check !== undefined) {
    const file = args.check === true ? ARENA_FILE : args.check, same = arenaMatches(readArena(file));
    console.log(same ? `${file} is seed ${ARENA_SEED}'s live map` : `${file} is behind; recapture with node tools/room-arena.mjs`);
    process.exit(same ? 0 : 1);
  }
  const file = args.out ?? ARENA_FILE, { map, graph } = generateArena();
  writeFileSync(file, gzipSync(serialize({ map, graph }), { level: 9 }));
  console.log(`${file}: seed ${ARENA_SEED}'s live map and portal graph`);
}
