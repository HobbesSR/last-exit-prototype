import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUST = path.resolve(fileURLToPath(new URL('../../rust', import.meta.url)));
const EDGE_BINARY = path.join(RUST, 'target', 'debug', process.platform === 'win32' ? 'last-exit-edge.exe' : 'last-exit-edge');
let built = false;

/** Builds the debug `last-exit-edge` binary once per process. */
export function buildEdge() {
  if (built) return EDGE_BINARY;
  execFileSync('cargo', ['build', '--locked', '-p', 'last-exit-edge'], { cwd: RUST, stdio: 'inherit' });
  built = true;
  return EDGE_BINARY;
}

/**
 * Spawns `last-exit-edge` linked to `server.edgeLink.port` and waits until the link handshake completes
 * so `/api/client-config` advertises both `webTransport` and `webSocket`.
 */
export async function spawnEdge(server, { port = 0, wsPort = 0, cert, key, stdio = ['ignore', 'ignore', 'inherit'] } = {}) {
  if (!server?.edgeLink?.port) throw new Error('spawnEdge requires a server with an active edgeLink');
  const binary = buildEdge();
  const args = ['--link', `127.0.0.1:${server.edgeLink.port}`, '--port', String(port), '--ws-port', String(wsPort)];
  if (cert && key) args.push('--cert', cert, '--key', key);
  const child = spawn(binary, args, { stdio });
  let exited = null;
  const exitPromise = new Promise(resolve => {
    child.once('exit', (code, signal) => { exited = { code, signal }; resolve(exited); });
  });
  const deadline = Date.now() + 15000;
  while (!server.edgeLink.info()) {
    if (exited) throw new Error(`last-exit-edge exited before linking (${JSON.stringify(exited)})`);
    if (Date.now() > deadline) {
      child.kill();
      await exitPromise;
      throw new Error('Timed out waiting for last-exit-edge to link');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return {
    process: child,
    async stop() {
      if (!exited) {
        child.kill();
        await exitPromise;
      }
    },
  };
}
