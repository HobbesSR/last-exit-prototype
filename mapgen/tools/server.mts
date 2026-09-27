#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: Record<string, string> = {
  public: path.join(root, "public"),
  src: path.join(root, "src"),
  content: path.join(root, "content"),
};
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".mts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
const portArg = process.argv.indexOf("--port");
// --port, else MAPGEN_PORT (a worktree's ../.env.local), else 4173. 0 asks the OS for a
// free port; the bound address is printed on start-up.
const port =
  portArg >= 0
    ? Number(process.argv[portArg + 1])
    : Number(process.env.MAPGEN_PORT || 4173);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("port must be an integer from 0 to 65535");
function candidate(urlPath: string): string | null {
  const pathname = decodeURIComponent(
    new URL(urlPath, "http://localhost").pathname,
  );
  if (pathname.includes("\\")) return null;
  const match = /^\/(src|content)(?:\/(.*))?$/.exec(pathname);
  const base = match ? roots[match[1]!]! : roots.public!;
  const relative = match
    ? match[2] || ""
    : pathname === "/"
      ? "index.html"
      : pathname.slice(1);
  const resolved = path.resolve(base, relative);
  return resolved.startsWith(`${base}${path.sep}`) ? resolved : null;
}
/**
 * The browser cannot execute TypeScript, and a build step would let the served
 * bundle drift from the source the CLI and MCP server run. Types are erased on
 * the way out instead, so all three surfaces read the same files.
 */
function serveStripped(file: string, res: http.ServerResponse, head: boolean) {
  let body: string;
  try {
    body = stripTypeScriptTypes(fs.readFileSync(file, "utf8"), {
      mode: "strip",
    });
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Type stripping failed: ${(error as Error).message}`);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
  });
  res.end(head ? undefined : body);
}
const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
    if (req.url === "/dev-nav.js") {
    const mainPort = process.env.PORT || 3100;
    const host = req.headers.host?.split(':')[0] || 'localhost';
    const mapgenUrl = `http://${host}:${port}`;
    const mainUrl = `http://${host}:${mainPort}`;
    const template = fs.readFileSync(path.join(root, "../shared/dev-nav.js"), "utf8");
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(`
${template.replace('export function renderDevNav', 'function renderDevNav')}
renderDevNav('${mainUrl}', '${mapgenUrl}');
`);
    return;
  }
  let file: string | null;
  try {
    file = candidate(req.url || "/");
  } catch {
    file = null;
  }
  if (!file) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const target = file;
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const extension = path.extname(target).toLowerCase();
    if (extension === ".ts" || extension === ".mts") {
      serveStripped(target, res, req.method === "HEAD");
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[extension] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(target).pipe(res);
  });
});
server.listen(port, "127.0.0.1", () =>
  process.stdout.write(
    `http://127.0.0.1:${(server.address() as { port: number }).port}\n`,
  ),
);
