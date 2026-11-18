// Builds the Rust core to WASM (docs/27). The module is a build output, never committed: every host
// builds its own, and tests/math.test.js's digests check that it computes what shared/math.ts does.
// Its bytes need not match another machine's; its results must.
//
//   npm run core:build    build it; Cargo makes this a no-op when nothing changed
//
// Callers import buildCore, which builds once per process and returns the module's path.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
/** Where Cargo writes the module. Node reads it from here; the browser will be served it (stage 2, #1175). */
export const CORE_WASM = path.join(root, 'rust/target/wasm32-unknown-unknown/release/last_exit_core.wasm');

let built = false;

export function buildCore() {
  if (built) return CORE_WASM;
  const result = spawnSync('cargo', ['build', '--locked', '--release', '-p', 'last-exit-core', '--target', 'wasm32-unknown-unknown'],
    { cwd: path.join(root, 'rust'), stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
  if (result.error) throw new Error(`cannot run cargo (${result.error.message}); install the toolchain rust/rust-toolchain.toml names`);
  if (result.status !== 0) throw new Error(`building the core failed:\n${result.stderr}`);
  built = true;
  return CORE_WASM;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`built ${path.relative(root, buildCore())}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
