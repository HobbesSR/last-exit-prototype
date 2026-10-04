/**
 * The Map Lab's work off the main thread: generating, reading a save (which may rebuild
 * every region), and the game's diagnostic, which takes about a minute on a game map.
 * Each request goes through the tools' core, as the CLI and MCP do.
 */
import { checkMap, generate, readMap } from "../core.ts";
import type { ToolMap } from "../core.ts";

export type LabRequest =
  | { kind: "generate"; seed: string; params: object; library: unknown }
  | { kind: "read"; saved: Uint8Array }
  | { kind: "diagnose"; map: ToolMap };

export type LabReply =
  | { kind: "map"; map: ToolMap; ms: number }
  | { kind: "diagnosis"; brokenPromises: NonNullable<ReturnType<typeof checkMap>["brokenPromises"]>; ms: number }
  | { kind: "error"; message: string };

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
