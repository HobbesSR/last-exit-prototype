#!/usr/bin/env node
/**
 * The map CLI (53, "Tools"): chain maps, placed by macro and built by the game's
 * strategies, saved in wire version 6.
 */
import fs from 'node:fs';
import process from 'node:process';
import { looksLikeBson } from '../macro/src/bson.ts';
import { chainMapToBson, chainMapToJson } from '../macro/src/chain/saving.ts';
import { CHAIN_LIBRARY, batch, checkMap, generate, parseJson, readMap, validateLibrary } from './core.ts';
import type { ToolMap } from './core.ts';
import { captureBaseline, compareSweep, positiveInteger, runSweep, sweepCases } from './sweep.mts';
import type { SweepBaseline } from './sweep.mts';

const PARAM_FLAGS = '[--mode game|playground] [--zone-width N --zone-height N] [--exits N --contestants N --hunters N] [--loot-chance X --loot-tier-step X]';
const HELP = `last-exit-map: chain maps (51), built by the game's region types

Commands:
  generate --seed SEED ${PARAM_FLAGS} [--cell-size N] [--library FILE] [--layout-only true] [--out FILE] [--format json|bson]
  validate FILE [--library FILE] [--diagnose true]   (a saved map, read with the library it was made from; or a library)
  batch [--count N] [--seed PREFIX] ${PARAM_FLAGS} [--library FILE] [--diagnose true] [--out FILE]
  library [--out FILE]   (the chain's library)
  sweep [--jobs N] (--out FILE [--count N] | --check FILE)   (per-view content hashes over a pinned seed set)
  help

--diagnose runs the game's per-region portal check beside the report. It takes about a minute on a game map.`;

const PARAMS = ['mode', 'zoneWidth', 'zoneHeight', 'exits', 'contestants', 'hunters', 'lootChance', 'lootTierStep'];

function options(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const arg = args[i]!, value = args[i + 1];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    // Flags are kebab-case on the command line and camelCase in params.
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${arg.slice(2)}`);
    result[key] = value;
  }
  return result;
}
const flag = (value: string | undefined): boolean => {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`expected true or false, not ${value}`);
};
const params = (o: Record<string, string>) =>
  Object.fromEntries(PARAMS.filter(key => o[key] !== undefined).map(key => [key, o[key]]));
const readLibrary = (file?: string): unknown =>
  file ? parseJson(fs.readFileSync(file, 'utf8'), file) : CHAIN_LIBRARY;

function write(data: string | Uint8Array, out?: string): void {
  if (out) fs.writeFileSync(out, data);
  else process.stdout.write(data);
}
const output = (value: unknown, out?: string) => write(`${JSON.stringify(value, null, 2)}\n`, out);

/** The encoding follows --format, or the output file's extension. */
function writeMap(map: ToolMap, out: string | undefined, format: string | undefined, results: boolean): void {
  const encoding = format ?? (out?.toLowerCase().endsWith('.bson') ? 'bson' : 'json');
  if (encoding === 'bson') write(chainMapToBson(map, { results }), out);
  else if (encoding === 'json') write(`${chainMapToJson(map, { results }, 2)}\n`, out);
  else throw new Error(`unknown format: ${encoding}`);
}

/** A saved map or a library, decided from the bytes rather than the name. */
function readMapOrLibrary(file: string, library: unknown): { map: ToolMap } | { library: unknown } {
  const bytes = new Uint8Array(fs.readFileSync(file));
  if (looksLikeBson(bytes)) return { map: readMap(bytes, library) };
  const value = parseJson(new TextDecoder().decode(bytes), file) as Record<string, unknown> | null;
  return value?.format === 'last-exit-map' ? { map: readMap(value, library) } : { library: value };
}

try {
  const [command = 'help', ...rest] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') process.stdout.write(`${HELP}\n`);
  else if (command === 'library') output(CHAIN_LIBRARY, options(rest).out);
  else if (command === 'generate') {
    const o = options(rest);
    if (o.seed === undefined) throw new Error('generate requires --seed');
    const cellSize = o.cellSize === undefined ? undefined : Number(o.cellSize);
    const map = generate(o.seed, params(o), readLibrary(o.library), cellSize);
    writeMap(map, o.out, o.format, !flag(o.layoutOnly));
  } else if (command === 'validate') {
    const [file, ...flags] = rest;
    if (!file || file.startsWith('--')) throw new Error('validate requires exactly one file');
    const o = options(flags);
    const read = readMapOrLibrary(file, readLibrary(o.library));
    const result = 'map' in read ? checkMap(read.map, { diagnose: flag(o.diagnose) }) : validateLibrary(read.library);
    output(result);
    if (!result.valid) process.exitCode = 1;
  } else if (command === 'batch') {
    const o = options(rest);
    const report = batch(o.seed ?? 'batch', o.count ?? 20, params(o), readLibrary(o.library), { diagnose: flag(o.diagnose) });
    output(report, o.out);
    if (!report.valid) process.exitCode = 1;
  } else if (command === 'sweep') {
    // It runs for minutes, so it is a command rather than part of npm test.
    const o = options(rest);
    if (!o.out === !o.check) throw new Error('sweep needs exactly one of --out or --check');
    // A check reruns exactly what the baseline pinned, so it can't quietly cover less.
    const baseline = o.check ? (parseJson(fs.readFileSync(o.check, 'utf8'), o.check) as SweepBaseline) : undefined;
    if (baseline && o.count) throw new Error("--check reruns the baseline's own cases; drop --count");
    // Both are checked before any map is generated or any file written.
    const cases = baseline?.provenance.cases ?? sweepCases(o.count ?? 120);
    const jobs = o.jobs === undefined ? undefined : positiveInteger('jobs', o.jobs);
    const started = performance.now();
    void runSweep(cases, jobs).then((entries) => {
      const seconds = Number(((performance.now() - started) / 1000).toFixed(0));
      const count = Object.keys(entries).length;
      if (o.out) {
        output(captureBaseline(cases, entries), o.out);
        process.stderr.write(`captured ${count} maps in ${seconds}s\n`);
        return;
      }
      const drift = compareSweep(baseline!, entries);
      output({ checked: count, seconds, drift });
      if (drift.length) process.exitCode = 1;
    }).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  } else throw new Error(`unknown command: ${command}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
