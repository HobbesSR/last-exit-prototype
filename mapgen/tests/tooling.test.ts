import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
function run(
  file: string,
  args: string[] = [],
  input?: string,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [file, ...args], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}
async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  server.close();
  await once(server, "close");
  return port;
}
async function startServer() {
  const port = await unusedPort();
  const child = spawn(node, ["tools/server.mts", "--port", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await once(child.stdout, "data");
  return { child, port };
}

test("CLI help and generate smoke test", async () => {
  const help = await run("tools/cli.mts", ["help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /generate/);
  const generated = await run("tools/cli.mts", ["generate", "--seed", "smoke"]);
  assert.equal(generated.code, 0, generated.err);
  const map = JSON.parse(generated.out);
  assert.ok(map.layout, "a V2 map is written as its layout");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "last-exit-map-"));
  const mapFile = path.join(dir, "map.json");
  fs.writeFileSync(mapFile, generated.out);
  const checked = await run("tools/cli.mts", ["validate", mapFile]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(checked.code, 0, checked.err);
  assert.equal(JSON.parse(checked.out).valid, true);
});

test("server maps public, source, and content files and blocks traversal", async (t) => {
  const { child, port } = await startServer();
  t.after(() => child.kill());
  const rootPage = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(rootPage.status, 200);
  assert.match(rootPage.headers.get("content-type")!, /html/);
  const good = await fetch(`http://127.0.0.1:${port}/src/core.ts`);
  assert.equal(good.status, 200);
  assert.match(good.headers.get("content-type")!, /javascript/);
  const content = await fetch(
    `http://127.0.0.1:${port}/content/default-library.json`,
  );
  assert.equal(content.status, 200);
  assert.match(content.headers.get("content-type")!, /json/);
  const blocked = await fetch(`http://127.0.0.1:${port}/tools/server.mts`);
  assert.ok([403, 404].includes(blocked.status));
  const traversal = await fetch(
    `http://127.0.0.1:${port}/%2e%2e/tools/server.mts`,
  );
  assert.ok([403, 404].includes(traversal.status));
});

test("MCP initialize, list, call, and unknown method", async () => {
  const child = spawn(node, ["tools/mcp.mts"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", (d) => {
    output += d;
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "map_generate", arguments: { seed: "smoke", params: { mode: "playground", zoneWidth: 2, zoneHeight: 1 } } } })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "nope" })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "map_generate", arguments: {} } })}\n`,
  );
  // The default map is a full 5 x 5 zone grid, so a generate call is closer to
  // a second than to an instant; wait long enough for every reply to land.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  if (child.exitCode === null) child.kill();
  await closed;
  const messages: Array<Record<string, any>> = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    messages.find((x) => x.id === 1)!.result.capabilities.tools !== undefined,
    true,
  );
  assert.ok(
    messages
      .find((x) => x.id === 2)!
      .result.tools.some((tool: { name: string }) => tool.name === "map_batch"),
  );
  assert.ok(messages.find((x) => x.id === 3)!.result.content[0].text);
  assert.equal(messages.find((x) => x.id === 4)!.error.code, -32601);
  assert.equal(messages.find((x) => x.id === 5)!.result.isError, true);
});
