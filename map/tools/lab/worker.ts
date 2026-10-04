/**
 * The Map Lab's work off the main thread: generating, reading a save (which may rebuild
 * every region), the game's diagnostic, which takes about a minute on a game map, and
 * rebuilding one region to trace its buildings. Each map request goes through the tools'
 * core, as the CLI and MCP do.
 */
import { checkMap, generate, readMap } from "../core.ts";
import type { ToolMap } from "../core.ts";
import type { RegionBrief } from "../../kernel/contract.ts";
import { buildRegion } from "../../micro/region-types.ts";
import { planBlock } from "../../micro/strategies/block.ts";
import type { BuildingTrace } from "../../micro/building/trace.ts";

export type LabRequest =
  | { kind: "generate"; seed: string; params: object; library: unknown }
  | { kind: "read"; saved: Uint8Array }
  | { kind: "diagnose"; map: ToolMap }
  | { kind: "drill"; brief: RegionBrief; stored: unknown };

export type LabReply =
  | { kind: "map"; map: ToolMap; ms: number }
  | { kind: "diagnosis"; brokenPromises: NonNullable<ReturnType<typeof checkMap>["brokenPromises"]>; ms: number }
  | { kind: "drill"; id: string; traces: BuildingTrace[]; lots: RegionBrief[]; difference: string | null; ms: number }
  | { kind: "error"; message: string };

/** Where two plain values first differ, as a path, or null when they are equal. */
function firstDifference(a: unknown, b: unknown, at = "result"): string | null {
  // A JSON round trip reads -0 as 0, so numbers compare with ===.
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b))
    return `${at}: ${JSON.stringify(a)?.slice(0, 60)} rebuilt, ${JSON.stringify(b)?.slice(0, 60)} stored`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const found = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], Array.isArray(a) ? `${at}[${key}]` : `${at}.${key}`);
    if (found) return found;
  }
  return null;
}

/**
 * Rebuild a region with an observer, as the map built it (53 "Region drill-down"). The
 * traces describe the rebuild, so they're only the stored region's when the two are equal.
 */
function drill(brief: RegionBrief, stored: unknown): Omit<Extract<LabReply, { kind: "drill" }>, "ms"> {
  const traces: BuildingTrace[] = [];
  const rebuilt = buildRegion(brief, undefined, (trace) => traces.push(trace));
  return { kind: "drill", id: brief.id, traces, lots: brief.type === "block" ? planBlock(brief).lots : [], difference: firstDifference(rebuilt, stored) };
}

function answer(request: LabRequest): LabReply {
  const started = performance.now();
  const ms = () => performance.now() - started;
  switch (request.kind) {
    case "generate":
      return { kind: "map", map: generate(request.seed, request.params, request.library), ms: ms() };
    case "read":
      return { kind: "map", map: readMap(request.saved), ms: ms() };
    case "diagnose":
      return { kind: "diagnosis", brokenPromises: checkMap(request.map, { diagnose: true }).brokenPromises!, ms: ms() };
    case "drill":
      return { ...drill(request.brief, request.stored), ms: ms() };
  }
}

self.onmessage = (event: MessageEvent<LabRequest>) => {
  let reply: LabReply;
  try {
    reply = answer(event.data);
  } catch (error) {
    reply = { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(reply);
};
