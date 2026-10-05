/**
 * The Map Lab's work off the main thread: generating, reading a save (which may rebuild
 * every region), the game's diagnostic, which takes about a minute on a game map,
 * rebuilding one region to trace its buildings, and measuring routes through the built map.
 * Each map request goes through the tools' core, as the CLI and MCP do.
 */
import { checkMap, generate, readMap } from "../core.ts";
import type { ToolMap } from "../core.ts";
import type { BuiltMap, RegionBrief } from "../../kernel/contract.ts";
import { buildRegion } from "../../micro/region-types.ts";
import { planBlock } from "../../micro/strategies/block.ts";
import { firstDifference } from "../../micro/difference.ts";
import type { BuildingTrace } from "../../micro/building/trace.ts";
import type { RegionElement } from "../../micro/types.ts";
import { measureRoutes } from "../routes.ts";
import { liveMismatch, liveRecipeMismatch } from "../../live.ts";
import type { RouteMeasure } from "../routes.ts";
import type { Vec2 } from "../../../shared/types.ts";

export type LabRequest =
  | { kind: "generate"; seed: string; params: object; library: unknown }
  | { kind: "read"; saved: Uint8Array }
  | { kind: "diagnose"; map: ToolMap }
  | { kind: "drill"; brief: RegionBrief; stored: unknown }
  | { kind: "routes"; built: BuiltMap<RegionElement>; from: Vec2; to: Vec2 };

export type LabReply =
  | { kind: "map"; map: ToolMap; ms: number; live: string[] }
  | { kind: "diagnosis"; brokenPromises: NonNullable<ReturnType<typeof checkMap>["brokenPromises"]>; ms: number }
  | { kind: "drill"; id: string; traces: BuildingTrace[]; lots: RegionBrief[]; difference: string | null; ms: number }
  | { kind: "routes"; measure: RouteMeasure; ms: number }
  | { kind: "error"; message: string };

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
    // Why a room wouldn't play the map (53 "Play in the game"). A map just generated is its
    // recipe's by construction; a read one is compared with its seed's, as a save can be edited.
    case "generate": {
      const map = generate(request.seed, request.params, request.library);
      return { kind: "map", map, ms: ms(), live: liveRecipeMismatch(map) };
    }
    case "read": {
      const map = readMap(request.saved);
      return { kind: "map", map, ms: ms(), live: liveMismatch(map) };
    }
    case "diagnose":
      return { kind: "diagnosis", brokenPromises: checkMap(request.map, { diagnose: true }).brokenPromises!, ms: ms() };
    case "drill":
      return { ...drill(request.brief, request.stored), ms: ms() };
    case "routes":
      return { kind: "routes", measure: measureRoutes(request.built, request.from, request.to), ms: ms() };
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
