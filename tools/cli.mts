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
import type { GeneratedMap } from "../src/types.ts";

const HELP = `last-exit-map\n\nCommands:\n  generate --seed SEED [--zone-width N --zone-height N --exits N] [--library FILE] [--out FILE] [--format json|bson]\n  validate FILE   (a map in either encoding, or a library)\n  batch [--count N] [--seed PREFIX] [--zone-width N --zone-height N --exits N] [--library FILE] [--out FILE]\n  library [--out FILE]\n  help`;

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
): { kind: "map"; map: GeneratedMap } | { kind: "library"; library: unknown } {
  const bytes = new Uint8Array(fs.readFileSync(file));
  if (looksLikeBson(bytes))
    return { kind: "map", map: decodeArtifact(decodeBson(bytes)) };
  const value = parseJson(new TextDecoder().decode(bytes), file) as Record<
    string,
    unknown
  >;
  if (value?.format === "last-exit-map")
    return { kind: "map", map: decodeArtifact(value) };
  // An in-memory map, as the MCP server returns it, still validates directly.
  if (Array.isArray(value?.walls) || Array.isArray(value?.features))
    return { kind: "map", map: value as unknown as GeneratedMap };
  return { kind: "library", library: value };
}
function params(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    ["zoneWidth", "zoneHeight", "exits"]
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
  } else if (command === "validate") {
    if (rest.length !== 1)
      throw new Error("validate requires exactly one file");
    const read = readArtifactOrLibrary(rest[0]!);
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
    writeMap(generate(o.seed, params(o), library), o.out, o.format);
  } else if (command === "batch") {
    const o = options(rest);
    const library = (
      o.library ? readJson(o.library) : DEFAULT_LIBRARY
    ) as typeof DEFAULT_LIBRARY;
    const report = batch(o.seed ?? "batch", o.count ?? 100, params(o), library);
    output(report, o.out);
    if (!report.valid) process.exitCode = 1;
  } else throw new Error(`unknown command: ${command}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
