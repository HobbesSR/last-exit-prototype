#!/usr/bin/env node
/**
 * The Map Lab's server (53, "Tools"). The lab shows both halves, so it serves macro's
 * sources, micro, the kernel and the game's portable core at their repository paths, and
 * relative imports between them resolve as they do in Node. Nothing else is served.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { getDevNavConfig } from "../../shared/dev-nav-server.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The game server hashes the repository root the same way.
const workspaceId = createHash("sha256").update(repository).digest("hex");
/** The lab's page. */
const INDEX = "map/tools/lab/index.html";
/** What may be served: these trees, and these single files, by repository path. */
const TREES = ["map/tools/lab/", "map/macro/src/", "map/macro/content/", "map/micro/", "map/kernel/", "shared/"];
const FILES = ["map/tools/core.ts", "map/tools/engines.ts", "map/tools/routes.ts","map/chain.ts", "map/engines.ts"];
/**
 * Bare specifiers in served modules. A module worker has no import map, so the server
 * resolves them, for the page and the worker alike.
 */
const BARE: Record<string, string> = { sat: "/vendor/sat.mjs", pathfinding: "/vendor/pathfinding.mjs" };
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const portArg = process.argv.indexOf("--port");
// --port, else MAPGEN_PORT (a worktree's .env.local), else 4173. 0 asks the OS for a free
// port; the bound address is printed on start-up.
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.MAPGEN_PORT || 4173);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer from 0 to 65535");

/** The file a URL names, or null when it isn't one the lab may serve. */
function candidate(urlPath: string): string | null {
  const pathname = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
  if (pathname.includes("\\") || pathname.includes("\0")) return null;
  const relative = pathname === "/" ? INDEX : pathname.slice(1);
  const resolved = path.resolve(repository, relative);
  const inside = path.relative(repository, resolved).split(path.sep).join("/");
  if (inside.startsWith("..") || path.isAbsolute(inside) || inside.split("/").includes("node_modules")) return null;
  return FILES.includes(inside) || TREES.some((tree) => inside.startsWith(tree)) ? resolved : null;
}

function bareResolved(source: string): string {
  return source.replace(/(\bfrom\s*|\bimport\s*)(["'])([^"'./][^"']*)\2/g, (match, keyword: string, quote: string, name: string) =>
    BARE[name] ? `${keyword}${quote}${BARE[name]}${quote}` : match);
}

function send(res: http.ServerResponse, head: boolean, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(head ? undefined : body);
}

/**
 * The browser cannot execute TypeScript, and a build step would let the served bundle
 * drift from the source the CLI and MCP run. Types are erased on the way out instead, so
 * every surface reads the same files.
 */
function serveModule(file: string, res: http.ServerResponse, head: boolean) {
  let body = fs.readFileSync(file, "utf8");
  if (/\.m?ts$/.test(file)) {
    try {
      body = stripTypeScriptTypes(body, { mode: "strip" });
    } catch (error) {
      send(res, head, 500, "text/plain; charset=utf-8", `Type stripping failed: ${(error as Error).message}`);
      return;
    }
  }
  send(res, head, 200, "text/javascript; charset=utf-8", bareResolved(body));
}

/** Where a `require` from the file `from` leads: a relative file, or a package's main file. */
function required(from: string, name: string): string {
  if (!name.startsWith(".")) {
    const root = path.join(repository, "node_modules", name);
    const main: string = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).main ?? "index.js";
    return required(path.join(root, "package.json"), `./${main}`);
  }
  const base = path.resolve(path.dirname(from), name);
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  return fs.existsSync(base) && fs.statSync(base).isFile() ? base : path.join(base, "index.js");
}

const vendored = new Map<string, string>();

/**
 * A CommonJS package (SAT, PathFinding.js) as one ES module, for the page and its worker
 * alike. Every file its `require`s reach is wrapped as a function of `module`, `exports` and
 * `require`, run once on first use, and the package's exports are the default export.
 */
function vendorModule(name: string): string {
  const cached = vendored.get(name);
  if (cached) return cached;
  const ids = new Map<string, number>(), factories: string[] = [];
  const visit = (file: string): number => {
    if (ids.has(file)) return ids.get(file)!;
    const id = factories.push("") - 1;
    ids.set(file, id);
    const source = fs.readFileSync(file, "utf8")
      .replace(/\brequire\((["'])([^"']+)\1\)/g, (_, _quote, target: string) => `require(${visit(required(file, target))})`);
    factories[id] = `function (module, exports, require) {\n${source}\n}`;
    return id;
  };
  visit(required(path.join(repository, "package.json"), name));
  const body = `const factories = [${factories.join(",\n")}], loaded = [];
function require(id) {
  if (!loaded[id]) {
    const module = (loaded[id] = { exports: {} });
    factories[id](module, module.exports, require);
  }
  return loaded[id].exports;
}
export default require(0);
`;
  vendored.set(name, body);
  return body;
}

const server = http.createServer(async (req, res) => {
  const head = req.method === "HEAD";
  if (req.method !== "GET" && !head) {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  const url = req.url || "/";
  if (url === "/favicon.ico") return send(res, head, 204, "image/x-icon", "");
  const vendor = Object.keys(BARE).find((name) => BARE[name] === url);
  if (vendor) return send(res, head, 200, "text/javascript; charset=utf-8", vendorModule(vendor));
  if (url === "/dev-nav-peer.json")
    return send(res, head, 200, "application/json", JSON.stringify({ kind: "mapgen", workspace: workspaceId }));
  if (url === "/dev-nav-config.json") {
    const config = await getDevNavConfig({
      kind: "mapgen", host: req.headers.host || "localhost", localPort: req.socket.localPort,
      peerPort: process.env.PORT, workspaceId,
    });
    return send(res, head, 200, "application/json", JSON.stringify(config));
  }
  let file: string | null;
  try {
    file = candidate(url);
  } catch {
    file = null;
  }
  if (!file) return send(res, head, 403, "text/plain; charset=utf-8", "Forbidden");
  const target = file;
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) return send(res, head, 404, "text/plain; charset=utf-8", "Not found");
    const extension = path.extname(target).toLowerCase();
    if ([".ts", ".mts", ".js", ".mjs"].includes(extension)) return serveModule(target, res, head);
    send(res, head, 200, types[extension] || "application/octet-stream", fs.readFileSync(target));
  });
});

server.listen(port, "127.0.0.1", () =>
  process.stdout.write(`http://127.0.0.1:${(server.address() as { port: number }).port}\n`));
