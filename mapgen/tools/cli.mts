#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import {
  DEFAULT_LIBRARY,
  batch,
  generate,
  parseJson,
  validateLibrary,
  validateMap,
} from "./shared.mts";
import {
  artifactToBson,
  artifactToJson,
  decodeArtifact,
} from "../src/artifact.ts";
import { decodeBson, looksLikeBson } from "../src/bson.ts";
import { listBuilders } from "../src/micro/index.ts";
import { generatePlannedMap, planMap } from "../src/plan/compose.ts";
import {
  captureBaseline,
  compareSweep,
  positiveInteger,
  runSweep,
  sweepCases,
} from "./sweep.mts";
import type { SweepBaseline } from "./sweep.mts";
import type { GeneratedMap, Library } from "../src/types.ts";

const HELP = `last-exit-map\n\nCommands:\n  plan --seed SEED [--zone-width N --zone-height N --exits N] [--out FILE] [--format json|bson]   (the planned generator)
  plan-only --seed SEED [--out FILE]   (the macro plan, without composing it)
  generate --seed SEED [--mode game|playground] [--zone-width N --zone-height N --exits N] [--library FILE] [--out FILE] [--format json|bson]\n  validate FILE [--library FILE]   (a map in either encoding, read with the library it was generated from; or a library)\n  batch [--count N] [--seed PREFIX] [--mode game|playground] [--zone-width N --zone-height N --exits N] [--library FILE] [--out FILE]\n  library [--out FILE]\n  sweep [--jobs N] (--out FILE [--count N] | --check FILE)   (per-layer content hashes that pin the map-layer refactor, #47)\n  help`;

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
function readJson(file: string): unknown {
  return parseJson(fs.readFileSync(file, "utf8"), file);
}
function options(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    // Flags are kebab-case on the command line and camelCase in params.
    const key = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const value = args[i + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`missing value for --${key}`);
    result[key] = value;
    i += 1;
  }
  return result;
}
function output(value: unknown, out?: string): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(text);
}
/**
 * Maps are written in the wire form, which BSON can carry as binary. The
 * encoding follows --format, or the output file's extension.
 */
function writeMap(map: GeneratedMap, out?: string, format?: string): void {
  const encoding =
    format ?? (out && out.toLowerCase().endsWith(".bson") ? "bson" : "json");
  if (encoding === "bson") {
    const bytes = artifactToBson(map);
    if (out) fs.writeFileSync(out, bytes);
    else process.stdout.write(bytes);
    return;
  }
  if (encoding !== "json") throw new Error(`unknown format: ${encoding}`);
  const text = `${artifactToJson(map, 2)}\n`;
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(text);
}
/** Read a map or a library, deciding from the bytes rather than the name. */
function readArtifactOrLibrary(
  file: string,
  library: Library,
): { kind: "map"; map: GeneratedMap } | { kind: "library"; library: unknown } {
  const bytes = new Uint8Array(fs.readFileSync(file));
  if (looksLikeBson(bytes))
    return { kind: "map", map: decodeArtifact(decodeBson(bytes), library) };
  const value = parseJson(new TextDecoder().decode(bytes), file) as Record<
    string,
    unknown
  >;
  if (value?.format === "last-exit-map")
    return { kind: "map", map: decodeArtifact(value, library) };
  // An in-memory map, as the MCP server returns it, still validates directly.
  if (Array.isArray(value?.walls) || Array.isArray(value?.features))
    return { kind: "map", map: value as unknown as GeneratedMap };
  return { kind: "library", library: value };
}
function params(o: Record<string, string>, includeMode = false): Record<string, string> {
  return Object.fromEntries(
    [...(includeMode ? ["mode"] : []), "zoneWidth", "zoneHeight", "exits"]
      .filter((k) => o[k] !== undefined)
      .map((k) => [k, o[k]]),
  );
}

try {
  const [command = "help", ...rest] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h")
    process.stdout.write(`${HELP}\n`);
  else if (command === "library") {
    const o = options(rest);
    output(DEFAULT_LIBRARY, o.out);
  } else if (command === "plan") {
    // The second generator. It takes no library: it plans regions over the cell
    // grid rather than placing authored tiles. See docs/PLANNED_GENERATION.md.
    const o = options(rest);
    if (o.seed === undefined) throw new Error("plan requires --seed");
    const map = generatePlannedMap(o.seed, params(o));
    writeMap(map, o.out, o.format);
    if (!map.validation.valid) process.exitCode = 1;
  } else if (command === "plan-only") {
    const o = options(rest);
    if (o.seed === undefined) throw new Error("plan-only requires --seed");
    output(planMap(o.seed, params(o)), o.out);
  } else if (command === "builders") {
    // The catalogue is data a library binds to by name, so it has to be
    // inspectable without reading the source that registers it.
    const o = options(rest);
    output(
      listBuilders().map((b) => ({
        id: b.id,
        minArea: b.minArea,
        description: b.description,
      })),
      o.out,
    );
  } else if (command === "validate") {
    const [file, ...flags] = rest;
    if (!file || file.startsWith("--"))
      throw new Error("validate requires exactly one file");
    const o = options(flags);
    // A map's structure is derived from its layout with the library it names.
    const library = (o.library ? readJson(o.library) : DEFAULT_LIBRARY) as Library;
    const read = readArtifactOrLibrary(file, library);
    const result =
      read.kind === "map"
        ? validateMap(read.map)
        : validateLibrary(read.library);
    output(result);
    if (!result.valid) process.exitCode = 1;
  } else if (command === "generate") {
    const o = options(rest);
    if (o.seed === undefined) throw new Error("generate requires --seed");
    const library = (
      o.library ? readJson(o.library) : DEFAULT_LIBRARY
    ) as typeof DEFAULT_LIBRARY;
    writeMap(generate(o.seed, params(o, true), library), o.out, o.format);
  } else if (command === "batch") {
    const o = options(rest);
    const library = (
      o.library ? readJson(o.library) : DEFAULT_LIBRARY
    ) as typeof DEFAULT_LIBRARY;
    const report = batch(o.seed ?? "batch", o.count ?? 100, params(o, true), library);
    output(report, o.out);
    if (!report.valid) process.exitCode = 1;
  } else if (command === "sweep") {
    // Pins generated content across the map-layer refactor (#47). It runs for
    // minutes, so it is a command rather than part of npm test.
    const o = options(rest);
    if (!o.out === !o.check) throw new Error("sweep needs exactly one of --out or --check");
    // A check reruns exactly what the baseline pinned, so it can't quietly cover less.
    const baseline = o.check ? (readJson(o.check) as SweepBaseline) : undefined;
    if (baseline && o.count) throw new Error("--check reruns the baseline's own cases; drop --count");
    // Both are checked before any map is generated or any file written.
    const cases = baseline?.provenance.cases ?? sweepCases(o.count ?? 120);
    const jobs = o.jobs === undefined ? undefined : positiveInteger("jobs", o.jobs);
    const started = performance.now();
    void runSweep(cases, jobs)
      .then((entries) => {
        const seconds = ((performance.now() - started) / 1000).toFixed(0);
        const count = Object.keys(entries).length;
        if (o.out) {
          output(captureBaseline(cases, entries), o.out);
          process.stderr.write(`captured ${count} maps in ${seconds}s\n`);
          return;
        }
        const drift = compareSweep(baseline!, entries);
        output({ checked: count, seconds: Number(seconds), drift });
        if (drift.length) process.exitCode = 1;
      })
      .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
  } else throw new Error(`unknown command: ${command}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
