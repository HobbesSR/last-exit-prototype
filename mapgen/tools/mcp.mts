#!/usr/bin/env node
import readline from "node:readline";
import {
  DEFAULT_LIBRARY,
  MAX_BATCH_COUNT,
  MAX_JSON_BYTES,
  batch,
  generate,
  validateLibrary,
  validateMap,
} from "./shared.mts";
import type { Library } from "../src/types.ts";

type Id = string | number | null | undefined;
interface Request {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: { name?: unknown; arguments?: unknown };
}
type Args = Record<string, unknown>;

const tools = [
  {
    name: "map_generate",
    description: "Generate a deterministic escape map.",
    inputSchema: {
      type: "object",
      required: ["seed"],
      properties: {
        seed: { type: ["string", "number"] },
        params: { type: "object" },
        library: { type: "object" },
      },
    },
  },
  {
    name: "map_validate",
    description: "Validate a generated map.",
    inputSchema: {
      type: "object",
      required: ["map"],
      properties: { map: { type: "object" } },
    },
  },
  {
    name: "library_validate",
    description: "Validate a feature library.",
    inputSchema: {
      type: "object",
      required: ["library"],
      properties: { library: { type: "object" } },
    },
  },
  {
    name: "map_batch",
    description: `Generate and validate up to ${MAX_BATCH_COUNT} maps, returning distribution metrics.`,
    inputSchema: {
      type: "object",
      properties: {
        seedPrefix: { type: ["string", "number"] },
        count: { type: "integer", minimum: 1, maximum: MAX_BATCH_COUNT },
        params: { type: "object" },
        library: { type: "object" },
      },
    },
  },
  {
    name: "library_get",
    description: "Get the default shipped feature library.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];
function reply(id: Id, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function error(id: Id, code: number, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })}\n`,
  );
}
function content(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}
function invoke(name: string, args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("arguments must be an object");
  const a = args as Args;
  if (name === "map_generate")
    return generate(a.seed, (a.params as Args) || {}, a.library as Library);
  if (name === "map_validate") return validateMap(a.map);
  if (name === "library_validate") return validateLibrary(a.library);
  if (name === "library_get") return DEFAULT_LIBRARY;
  if (name === "map_batch")
    return batch(
      (a.seedPrefix as string) ?? "batch",
      a.count ?? 100,
      (a.params as Args) || {},
      a.library as Library,
    );
  throw new Error(`unknown tool: ${name}`);
}
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
rl.on("line", (line: string) => {
  let request: Request | undefined;
  try {
    if (Buffer.byteLength(line) > MAX_JSON_BYTES)
      throw new Error("request too large");
    request = JSON.parse(line);
    if (
      !request ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string"
    ) {
      error(request?.id, -32600, "Invalid Request");
      return;
    }
    const notification = request.id === undefined;
    if (request.method === "notifications/initialized") return;
    if (request.method === "initialize") {
      if (!notification)
        reply(request.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "last-exit-map", version: "0.1.0" },
        });
      return;
    }
    if (request.method === "ping") {
      if (!notification) reply(request.id, {});
      return;
    }
    if (request.method === "tools/list") {
      if (!notification) reply(request.id, { tools });
      return;
    }
    if (request.method === "tools/call") {
      const p = request.params;
      if (
        !p ||
        typeof p.name !== "string" ||
        (p.arguments !== undefined &&
          (!p.arguments ||
            typeof p.arguments !== "object" ||
            Array.isArray(p.arguments)))
      ) {
        if (!notification) error(request.id, -32602, "Invalid params");
        return;
      }
      if (!notification) {
        try {
          reply(
            request.id,
            content(invoke(p.name as string, (p.arguments as Args) || {})),
          );
        } catch (e) {
          reply(
            request.id,
            content(
              { error: e instanceof Error ? e.message : String(e) },
              true,
            ),
          );
        }
      }
      return;
    }
    if (!notification) error(request.id, -32601, "Method not found");
  } catch (e) {
    if (request?.id !== undefined)
      error(
        request.id,
        request ? -32602 : -32700,
        e instanceof Error ? e.message : "Invalid Request",
      );
  }
});
