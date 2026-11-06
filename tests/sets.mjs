import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Test sets (31, "Test sets"; #800): every test file belongs to exactly one set, named for what it
// validates. A set lists its fast, slow and browser members and the source paths whose change
// should prompt it. Run sets through the thin reporter:
//   npm run brief -- test:set physics            the set's fast files
//   npm run brief -- test:set micro:depot        the micro files whose name holds "depot"
//   npm run brief -- test:set rooms --slow       fast and slow files
//   npm run brief -- test:set physics --browser  then its browser scripts, one at a time
//   node tests/sets.mjs browser [set|set:word ...]  browser scripts alone: every set's (npm run test:browser) or these
//   node tests/sets.mjs list                     sets, member counts and recorded time
//   node tests/sets.mjs changed [base]           sets whose sources this branch touched
// Members are file stems (`physics-world` is tests/physics-world.test.js, tests/slow/…, or
// tests/physics-world.browser.mjs), or a prefix ending in `*` for a family that shares one.
// A browser script drives Chrome: *.browser.mjs or .mts in BROWSER_DIRS, and tests/browser.mjs. A script
// in another directory is found only once its directory joins BROWSER_DIRS. Why each set's slow and browser members exist is 31's per-set table.

/** @type {Record<string, { about: string, fast: string[], slow?: string[], browser?: string[], sources: string[] }>} */
export const SETS = {
  tooling: {
    about: 'the test and CI tooling, documentation and licence checks',
    fast: ['brief-reporter', 'ci-cancel-pr-runs', 'ci-slow-failures', 'doc-reads', 'forgejo-usage', 'machine-lock',
      'third-party-notices', 'vendor-modules', 'source-provenance', 'timing', 'profiler', 'depot-cord-source', 'sets'],
    sources: ['tests/*.mjs', 'tests/helpers/**', 'tools/**', '.forgejo/**', 'docs/**', 'AGENTS.md', 'package.json', 'THIRD_PARTY_NOTICES*', 'shared/profiler.ts'],
  },
  geometry: {
    about: 'shapes, clipping, math and free-space meshes every system shares',
    fast: ['shape', 'shape-clipping', 'shape-construction', 'math', 'free-space', 'swept-index', 'map-cell-primitives'],
    sources: ['shared/shape*.ts', 'shared/math.ts', 'shared/free-space.ts', 'shared/vector.ts', 'shared/numbers.ts', 'shared/buckets.ts', 'shared/index-heap.ts'],
  },
  client: {
    about: 'what the browser draws and how it presents and buffers frames',
    fast: ['appearance', 'event-light', 'palette', 'snapshot-buffer', 'lab-walk', 'diagnostics-episodes'],
    browser: ['art-witness', 'overhead', 'dev-view'],
    sources: ['public/**'],
  },
  simulation: {
    about: 'game rules, items, bots, navigation, sight and projections, and the legacy generator',
    fast: ['simulation', 'characterization', 'equipment', 'loot-tiers', 'item-*', 'ground-items', 'traps', 'transit',
      'utility-use', 'hearing', 'hearing-bots', 'hunting', 'hunter-planning', 'discovery', 'visibility', 'view', 'view-items',
      'projection-contract', 'presentation', 'frame-gates', 'frame-layers', 'rewind', 'reloading', 'input-queue',
      'movement-speed', 'bot-discovery', 'navigation-*', 'route', 'boundaries', 'arena', 'playability', 'shared-rules', 'content'],
    slow: ['characterization-bots', 'map-sweep'],
    browser: ['hearing', 'transit'],
    sources: ['shared/simulation*', 'shared/simulation/**', 'shared/movement.ts', 'shared/view.ts', 'shared/discovery.ts', 'shared/equipment.ts',
      'shared/item-instances.ts', 'shared/loot-tiers.ts', 'shared/traps.ts', 'shared/gate-query.ts', 'shared/presentation.ts',
      'shared/frame-layers.ts', 'shared/navigation/**', 'shared/map.ts', 'shared/map/**', 'shared/types.ts', 'shared/waiting-yard.ts'],
  },
  physics: {
    about: 'the Rapier physics engine, its items, hook, ballistics and physical navigation',
    fast: ['physics-*', 'bot-intents'],
    slow: ['physics-navigation'],
    browser: ['default-physics', 'physics-*'],
    sources: ['shared/physics/**', 'public/physics-*', 'public/dev/physics-lab*', 'public/dev/squish-shell.js'],
  },
  rooms: {
    about: 'the server: rooms, matchmaking, recording and replay, the map pool and live-map wiring',
    fast: ['server', 'server-*', 'room-*', 'recording', 'recording-failure', 'replay-*', 'waiting', 'shutdown', 'http-json',
      'client-config', 'latency', 'map-pool', 'map-generator', 'live-map', 'live-map-adapter'],
    slow: ['live-map', 'room-sizes', 'room-sizes-physics'],
    browser: ['browser'],
    sources: ['server/**', 'shared/recording.ts', 'map/live*.ts'],
  },
  macro: {
    about: 'macro generation, the chain and its library, map tools and the Map Lab (also npm run test:mapgen)',
    fast: ['map-access-conservatism', 'map-authored-seams', 'map-block-library-audit', 'map-boundary', 'map-clear-tiles',
      'map-container', 'map-entrypoint', 'map-hall-wing-library', 'map-inward-authoring', 'map-inward-seams',
      'map-lab-draft-safety', 'map-lab-routes', 'map-library', 'map-navigation-structure', 'map-navigation-structure-cli',
      'map-passable-margins', 'map-portal-thorough', 'map-sweep-replay', 'map-sweep', 'map-tools', 'portal-graph',
      'macro-curtain', 'static-barrier-composition', 'static-barrier-routes', 'appearance-descriptor'],
    slow: ['map-library', 'map-macro-sizes'],
    browser: ['lab'],
    sources: ['map/macro/**', 'map/kernel/**', 'map/tools/**', 'map/*.ts'],
  },
  micro: {
    about: 'region builders and their machinery and the micro labs; select one type with micro:<type> (also npm run test:micro)',
    fast: ['micro-*', 'element', 'region-examples'],
    slow: ['micro-*'],
    browser: ['micro-lab', 'region-explorer', 'decomposition-lab', 'generation-demo'],
    sources: ['map/micro/**', 'map/kernel/**', 'public/micro-lab*', 'public/decomposition-*', 'public/generation-demo*'],
  },
};

const FAST_DIR = 'tests', SLOW_DIR = 'tests/slow', BROWSER_DIRS = ['tests', 'map/tools/tests'];
export const stem = file => path.basename(file).replace(/\.(test\.js|browser\.mjs|browser\.mts|mjs)$/, '');
export const matches = (pattern, name) => pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
const listed = (dir, suffix) => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(suffix)).map(f => `${dir}/${f}`) : [];

/** Every unit and browser test file, by tier. A browser script is found by its name, so a new one cannot escape
 * the catalog test, and `npm run test:browser`, the union of the sets' browser members, runs it. */
export function inventory() {
  const browser = [...BROWSER_DIRS.flatMap(dir => [...listed(dir, '.browser.mjs'), ...listed(dir, '.browser.mts')]), `${FAST_DIR}/browser.mjs`]
    .filter(file => existsSync(file)).sort();
  return { fast: listed(FAST_DIR, '.test.js'), slow: listed(SLOW_DIR, '.test.js'), browser };
}

/** Run browser scripts one at a time, reporting each with its time, so one failure hides none of the rest. */
export function runBrowser(scripts, env = process.env, run = script => spawnSync(process.execPath, [script], { stdio: 'inherit', env }).status) {
  const failed = [];
  const started = Date.now();
  for (const script of scripts) {
    const at = Date.now();
    // Browser scripts are not node:test files; a reporter in NODE_OPTIONS would only get in their way.
    const status = run(script, { ...env, NODE_OPTIONS: '' });
    console.log(`${status === 0 ? 'ok  ' : 'FAIL'} ${script} ${((Date.now() - at) / 1000).toFixed(1)}s`);
    if (status !== 0) failed.push(script);
  }
  console.log(`browser: ${scripts.length - failed.length} ok, ${failed.length} failed, ${((Date.now() - started) / 1000).toFixed(0)} s${failed.length ? `
  failed: ${failed.join(' ')}` : ''}`);
  return failed.length ? 1 : 0;
}

/** The sets each file of `files` (a tier's list) belongs to, by its stem. */
export function membership(files, tier) {
  return new Map(files.map(file => [file, Object.keys(SETS).filter(name => (SETS[name][tier] ?? []).some(p => matches(p, stem(file))))]));
}

/** The files `selector` names in `tier`: a set, or `set:word` for its members whose stem holds the word. */
export function resolve(selector, tier, files = inventory()[tier]) {
  const [name, word] = selector.split(':');
  if (!SETS[name]) throw new Error(`Unknown test set ${JSON.stringify(name)}. Sets: ${Object.keys(SETS).join(', ')}.`);
  return files.filter(file => (SETS[name][tier] ?? []).some(p => matches(p, stem(file))) && (!word || stem(file).includes(word)));
}

/** Sets whose sources include one of `changed` (repository paths with forward slashes). */
export function setsFor(changed) {
  return Object.keys(SETS).filter(name => changed.some(file => SETS[name].sources.some(glob => path.matchesGlob(file, glob))));
}

const USAGE = 'usage: node tests/sets.mjs <set|set:word ...> [--slow] [--browser] | browser [set|set:word ...] | list | changed [base]';

const recordedMs = () => {
  try {
    const runs = JSON.parse(readFileSync('test-results/test-times/test.json', 'utf8')).runs;
    return runs.at(-1)?.files ?? {};
  } catch { return {}; }
};

function main(args) {
  const flags = new Set(args.filter(a => a.startsWith('--'))), names = args.filter(a => !a.startsWith('--'));
  if (names[0] === 'list') {
    const files = inventory(), ms = recordedMs();
    for (const name of Object.keys(SETS)) {
      const fast = resolve(name, 'fast', files.fast), slow = resolve(name, 'slow', files.slow), browser = resolve(name, 'browser', files.browser);
      const known = fast.filter(f => ms[f] !== undefined), total = known.reduce((sum, f) => sum + ms[f], 0);
      const time = known.length ? `, ${(total / 1000).toFixed(0)} s serial in the last npm test` : '';
      console.log(`${name.padEnd(11)} ${fast.length} fast, ${slow.length} slow, ${browser.length} browser${time}: ${SETS[name].about}`);
    }
    return 0;
  }
  if (names[0] === 'changed') {
    const base = names[1] ?? 'forgejo/main';
    const git = a => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
    const changed = [...new Set([...git(['diff', '--name-only', `${base}...HEAD`]), ...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])])];
    const sets = setsFor(changed);
    console.log(sets.length ? `sets touched since ${base}: ${sets.join(' ')}\n  npm run brief -- test:set ${sets.join(' ')}` : `no set's sources changed since ${base}`);
    return 0;
  }
  if (names[0] === 'browser') {
    const files = inventory().browser, chosen = names.slice(1);
    const scripts = chosen.length ? [...new Set(chosen.flatMap(n => resolve(n, 'browser', files)))] : files;
    if (!scripts.length) { console.error(`no browser scripts in ${chosen.join(' ')}`); return 1; }
    return runBrowser(scripts);
  }
  if (!names.length) {
    console.error(USAGE);
    return 2;
  }
  const files = inventory();
  const unit = [...new Set(names.flatMap(n => [...resolve(n, 'fast', files.fast), ...(flags.has('--slow') ? resolve(n, 'slow', files.slow) : [])]))];
  const browser = flags.has('--browser') ? [...new Set(names.flatMap(n => resolve(n, 'browser', files.browser)))] : [];
  if (!unit.length && !browser.length) { console.error(`no test files in ${names.join(' ')}`); return 1; }
  // The thin reporter's record is named for the selection, so each keeps its own history.
  const env = { ...process.env, BRIEF_SCRIPT: `set-${names.join('+').replace(/:/g, '-')}${flags.has('--slow') ? '-slow' : ''}` };
  let status = 0;
  if (unit.length) status = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...unit], { stdio: 'inherit', env }).status ?? 1;
  if (browser.length && runBrowser(browser, env) !== 0) status ||= 1;
  return status;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // A mistyped set is a usage error, not a crash: say what exists instead of a stack.
    console.error(String(error.message ?? error));
    console.error(USAGE);
    process.exitCode = 2;
  }
}
