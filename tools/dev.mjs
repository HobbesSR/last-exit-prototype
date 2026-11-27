// Starts the Node arena server alongside `last-exit-edge` for local development (`npm run dev` / `npm run dev:lan`).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUST = path.join(ROOT, 'rust');
const EDGE_BIN = path.join(RUST, 'target', 'debug', process.platform === 'win32' ? 'last-exit-edge.exe' : 'last-exit-edge');

execFileSync('cargo', ['build', '--locked', '-p', 'last-exit-edge'], { cwd: RUST, stdio: 'inherit' });
if (!existsSync(EDGE_BIN)) {
  console.error(`Expected built edge binary at ${EDGE_BIN}`);
  process.exit(1);
}

const serverArgs = ['server/index.js', ...process.argv.slice(2)];
const nodeEnv = { ...process.env };
if (nodeEnv.EDGE_LINK_PORT === undefined || nodeEnv.EDGE_LINK_PORT === '') nodeEnv.EDGE_LINK_PORT = '0';

const server = spawn(process.execPath, serverArgs, { cwd: ROOT, env: nodeEnv, stdio: ['inherit', 'pipe', 'inherit'] });
let edge = null;
let shuttingDown = false;
let lineBuf = '';

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (edge && edge.exitCode === null) edge.kill();
  if (server.exitCode === null) server.kill();
  process.exitCode = code;
}

function startEdge(linkPort) {
  const args = [
    '--link', `127.0.0.1:${linkPort}`,
    '--port', process.env.EDGE_PORT || '0',
    '--ws-port', process.env.EDGE_WS_PORT || '0',
  ];
  if (process.argv.includes('--lan') || process.env.LAN === '1') {
    args.push('--lan');
  } else if (process.env.HOST) {
    args.push('--bind', process.env.HOST);
  }
  if (process.env.EDGE_CERT && process.env.EDGE_KEY) {
    args.push('--cert', process.env.EDGE_CERT, '--key', process.env.EDGE_KEY);
  }
  edge = spawn(EDGE_BIN, args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  edge.on('exit', code => {
    if (!shuttingDown) shutdown(code ?? 1);
  });
}

server.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  if (edge) return;
  lineBuf += chunk.toString('utf8');
  const lines = lineBuf.split(/\r?\n/);
  lineBuf = lines.pop() ?? '';
  for (const line of lines) {
    const match = line.match(/^Edge link on 127\.0\.0\.1:(\d+)/);
    if (match) {
      startEdge(match[1]);
      break;
    }
  }
});

server.on('exit', code => {
  if (!shuttingDown) shutdown(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}
