// #1139: the live state message's data model as the engine emits it. Projects every player's own view and the
// directed (dev) view each tick with production `match.project`, walks the projected records, and reports per field:
// value kinds, number class (integer, float32-exact, float64), range, null and absence frequency, and string
// cardinality. Coverage is checked against the projection declarations. Frame layers are a transport detail on top
// of this and are not walked. Delayed spectators see the dev view's records later, so they add no fields.
// Usage: node tools/perf/wire-data-model.mjs --maps-cache=FILE --out=FILE [--ticks=1200] [--stride=1]
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { FRAME_FIELDS, GATE_FIELDS, TRAP_FIELDS, PROJECTILE_FIELDS, EFFECT_FIELDS, EVENT_FIELDS } from '../../shared/simulation/projection-contract.ts';
import { SCALE } from '../../shared/physics/world.ts';
import { sliceFieldLists } from './wire-slice-fields.mjs';
import { loadCachedMatch } from './wire-cached-match.mjs';

const args = cliArgs(), ticks = Number(args.get('ticks') ?? 1200), stride = Number(args.get('stride') ?? 1);
if (!args.has('maps-cache') || !args.has('out')) throw new Error('--maps-cache and --out required');
// Reviewed declaration-only changes since the caches' source revision, pinned by the hash of their diff (review 868):
// a different change to these files is refused, not trusted by file name.
const REVIEWED_CHANGES = {
  'shared/simulation/projection-contract.ts': 'ae1f5f909075afcef5ebc05fe26b5fc7e3dd8bc1d56243e0b351b047bde14ca5',
  'shared/simulation/visibility.ts': '22f588c1a8ebf8aa5579dc52293aef49e318f3f0a6b627c63f072fce7044cf08',
  'shared/physics/world.ts': '4c56acfe33a6a89a5419b3a1ef330322c9dc497af943aba3d568251546bc9a1d',
};
const STRING_CAP = 48;

// Where a record sits: the path of its list or field, with list entries as [] and the player union split by viewer.
const FAMILY = {
  '': 'header', 'players[own]': 'ownPlayer', 'players[observed]': 'observedPlayer', 'items[]': 'item',
  'players[own].inventory[]': 'item', 'players[own].cell': 'item', 'players[own].reload': 'reload', 'players[own].heard[]': 'heard',
  'gates[]': 'gate', 'traps[]': 'trap', 'projectiles[]': 'projectile', 'effects[]': 'effect', 'events[]': 'event',
  'bodies[]': 'body', 'bodies[].shape': 'shape', 'bodies[].shape.vertices[]': 'vertex', 'tethers[]': 'tether',
  'hookFlights[]': 'hookFlight', 'predictionMotor': 'predictionMotor',
};
const MAPS = new Set(['players[own].reserves']);

const lock = await acquireMachineLock('bench', { mode: 'shared' });
let match;
try {
  const loaded = await loadCachedMatch(args.get('maps-cache'), { reviewedChanges: REVIEWED_CHANGES });
  match = loaded.match;
  const fields = new Map(), records = new Map();
  const field = path => { let f = fields.get(path); if (!f) fields.set(path, f = newField()); return f; };
  const roster = match.snapshot().players, viewers = [...roster.map(p => p.id), undefined];
  // The same pose sent twice: a player's x/y beside its actor body's, and a ground item's beside its item body's.
  const duplicates = { player: { pairs: 0, identical: 0, maxDifference: 0, withoutBody: 0 }, item: { pairs: 0, identical: 0, maxDifference: 0 } };
  let current, projections = 0;
  for (let at = 0; at <= ticks; at++) {
    current = at ? match.advance() : match.snapshot();
    if (at % stride === 0) for (const viewer of viewers) { const view = match.project(current, viewer); walkRecord(view, '', viewer); comparePoses(view); projections++; }
    if (match.phase !== 'live') break;
  }

  function comparePoses(view) {
    const bodies = new Map((view.bodies ?? []).map(b => [b.id, b]));
    const note = (d, a, b) => { const diff = Math.hypot(a.x - b.x, a.y - b.y); d.pairs++; if (diff === 0) d.identical++; d.maxDifference = Math.max(d.maxDifference, diff); };
    for (const p of view.players) { const b = bodies.get(`actor:${p.id}`); if (b) note(duplicates.player, p, b); else duplicates.player.withoutBody++; }
    for (const i of view.items) { const b = bodies.get(`item:${i.id}`); if (b) note(duplicates.item, i, b); }
  }

  function walkRecord(record, path, viewer) {
    records.set(path, (records.get(path) ?? 0) + 1);
    for (const [key, value] of Object.entries(record)) {
      if (key === 'players' && Array.isArray(value)) {
        field('players').present++; field('players').kinds.array++;
        for (const p of value) walkRecord(p, p.id === viewer ? 'players[own]' : 'players[observed]', viewer);
        continue;
      }
      walkValue(value, path ? `${path}.${key}` : key, viewer);
    }
  }
  function walkValue(value, path, viewer) {
    const f = field(path);
    if (value === undefined) { f.kinds.undefined++; return; }
    f.present++;
    if (value === null) { f.kinds.null++; return; }
    if (Array.isArray(value)) {
      f.kinds.array++; f.maxLength = Math.max(f.maxLength, value.length);
      for (const v of value) walkValue(v, `${path}[]`, viewer);
      return;
    }
    if (typeof value === 'object') {
      f.kinds.object++;
      if (MAPS.has(path)) { for (const [k, v] of Object.entries(value)) { noteString(field(`${path}{key}`), k); walkValue(v, `${path}{}`, viewer); } return; }
      walkRecord(value, path, viewer);
      return;
    }
    if (typeof value === 'number') return noteNumber(f, value);
    if (typeof value === 'string') return noteString(f, value);
    if (typeof value === 'boolean') { f.kinds.boolean++; f[value ? 'trues' : 'falses']++; return; }
    f.kinds.other++;
  }

  // Coverage against the declarations: every declared field of each family, and every observed field.
  const lists = sliceFieldLists();
  const declared = {
    header: [...FRAME_FIELDS.split(' '), 'directed', 'contestantsActive', 'physicsProfile', 'bodies', 'tethers', 'hookFlights', 'predictionMotor', 'predictionTethered', 'hookActive'],
    ownPlayer: lists.own, observedPlayer: lists.observed, item: lists.item, gate: GATE_FIELDS.split(' '), trap: TRAP_FIELDS.split(' '),
    projectile: PROJECTILE_FIELDS.split(' '), effect: EFFECT_FIELDS.split(' '), event: EVENT_FIELDS.split(' '),
    body: lists.body.order, shape: [...new Set(Object.values(lists.shapes).flat())], vertex: lists.vertex, heard: lists.heard,
    tether: ['id', 'a', 'b'], hookFlight: ['id', 'a', 'x', 'y'], predictionMotor: ['acceleration', 'braking', 'maxSpeed', 'surfaces'],
    reload: ['slot', 'instanceId', 'until'],
  };
  const families = {};
  for (const [path, f] of fields) {
    const cut = path.lastIndexOf('.'), parent = cut < 0 ? '' : path.slice(0, cut), name = cut < 0 ? path : path.slice(cut + 1);
    const family = FAMILY[parent] ?? 'nested';
    // A family can sit at several paths (ground items, inventory entries, the carried cell): one row per path.
    ((families[family] ??= {})[parent || '(state)'] ??= {})[name] = summarize(f, name.endsWith('[]') ? undefined : records.get(parent));
  }
  const coverage = {};
  for (const [family, names] of Object.entries(declared)) {
    const seen = [...new Set(Object.values(families[family] ?? {}).flatMap(Object.keys))].filter(n => !n.endsWith('[]')); // element rows of primitive lists
    coverage[family] = { declared: names.length, observed: seen.filter(n => names.includes(n)).length,
      neverObserved: names.filter(n => !seen.includes(n)), undeclared: seen.filter(n => !names.includes(n)) };
  }
  const recordCounts = Object.fromEntries([...records].map(([p, n]) => [p || '(state)', n]));

  const file = p => readFile(new URL(p, import.meta.url));
  const hash = data => createHash('sha256').update(data).digest('hex');
  const result = { issue: 1139, date: new Date().toISOString(), node: process.version, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    cache: loaded.provenance, scale: SCALE, ticks, actualTicks: current.tick, stride, viewers: viewers.length, projections,
    sources: Object.fromEntries(await Promise.all(['./wire-data-model.mjs', './wire-cached-match.mjs', './wire-slice-fields.mjs'].map(async p => [p, hash(String(await file(p)).replace(/\r\n/g, '\n'))]))),
    coverage, duplicates, recordCounts, families, contention: lock.contention() };
  await writeFile(args.get('out'), JSON.stringify(result, null, 1) + '\n');
  console.log(JSON.stringify({ size: loaded.provenance.size, out: args.get('out'), projections, coverage: Object.fromEntries(Object.entries(coverage).map(([k, v]) => [k, `${v.observed}/${v.declared}` + (v.undeclared.length ? ` +${v.undeclared}` : '')])) }));
} finally { match?.dispose(); lock.release(); }

function newField() {
  return { present: 0, kinds: { undefined: 0, null: 0, number: 0, string: 0, boolean: 0, array: 0, object: 0, other: 0 },
    integers: 0, float32: 0, scaledFloat32: 0, float64: 0, metreRoundTrip: 0, metreFailures: [], negativeZero: 0, min: Infinity, max: -Infinity, maxAbsInteger: 0, nonInteger: { min: Infinity, max: -Infinity },
    strings: new Set(), stringOverflow: false, maxStringLength: 0, trues: 0, falses: 0, maxLength: 0 };
}
function noteNumber(f, v) {
  f.kinds.number++;
  // The float32-metre encoding tested on every value, integers and float32 values included (review 868): send
  // fround(v / SCALE), decode by multiplying by SCALE. It is exact only when that round trip returns v.
  if (Math.fround(v / SCALE) * SCALE === v) f.metreRoundTrip++;
  else if (f.metreFailures.length < 4 && !f.metreFailures.includes(v)) f.metreFailures.push(v);
  if (Object.is(v, -0)) f.negativeZero++;
  if (v < f.min) f.min = v; if (v > f.max) f.max = v;
  if (Number.isInteger(v)) { f.integers++; f.maxAbsInteger = Math.max(f.maxAbsInteger, Math.abs(v)); return; }
  if (v < f.nonInteger.min) f.nonInteger.min = v; if (v > f.nonInteger.max) f.nonInteger.max = v;
  // A world value that is a Rapier float32 metre times SCALE is exact as that float32 (x = fround(x / SCALE) * SCALE).
  if (Math.fround(v) === v) f.float32++; else if (Math.fround(v / SCALE) * SCALE === v) f.scaledFloat32++; else f.float64++;
}
function noteString(f, s) {
  f.kinds.string++; f.maxStringLength = Math.max(f.maxStringLength, s.length);
  if (f.strings.size < STRING_CAP) f.strings.add(s); else if (!f.strings.has(s)) f.stringOverflow = true;
}
function summarize(f, parentRecords) {
  const kinds = Object.fromEntries(Object.entries(f.kinds).filter(([, n]) => n));
  const row = { present: f.present, kinds };
  if (parentRecords !== undefined) row.absentShare = +(1 - f.present / parentRecords).toFixed(4);
  if (f.kinds.null) row.nullShare = +(f.kinds.null / f.present).toFixed(4);
  if (f.kinds.number) {
    const n = f.kinds.number;
    row.numbers = { integer: +(f.integers / n).toFixed(4), float32: +(f.float32 / n).toFixed(4), scaledFloat32: +(f.scaledFloat32 / n).toFixed(4), float64: +(f.float64 / n).toFixed(4),
      metreRoundTrip: +(f.metreRoundTrip / n).toFixed(4), metreFailures: f.kinds.number - f.metreRoundTrip, ...(f.metreFailures.length ? { metreFailureExamples: f.metreFailures } : {}),
      min: f.min, max: f.max, maxAbsInteger: f.maxAbsInteger, ...(f.integers < n ? { nonIntegerRange: [f.nonInteger.min, f.nonInteger.max] } : {}),
      ...(f.negativeZero ? { negativeZero: f.negativeZero } : {}) };
  }
  if (f.kinds.string) row.strings = { distinct: f.stringOverflow ? `>${STRING_CAP}` : f.strings.size, maxLength: f.maxStringLength, values: [...f.strings].slice(0, 12) };
  if (f.kinds.boolean) row.booleans = { true: f.trues, false: f.falses };
  if (f.kinds.array) row.maxListLength = f.maxLength;
  return row;
}
