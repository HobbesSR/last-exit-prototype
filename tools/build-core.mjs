// Builds the Rust core to WASM and copies it to shared/core.wasm, the committed module Node and the
// browser load (docs/27). CI's rust workflow rebuilds it and fails if the bytes differ, so run this
// after any change under rust/core and commit the result.
//
//   npm run core:build            build and copy
//   npm run core:build -- --check build and compare, leaving shared/core.wasm alone
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';

const built = 'rust/target/wasm32-unknown-unknown/release/last_exit_core.wasm';
const committed = 'shared/core.wasm';
const result = spawnSync('cargo', ['build', '--locked', '--release', '-p', 'last-exit-core', '--target', 'wasm32-unknown-unknown'],
  { cwd: 'rust', stdio: 'inherit' });
if (result.error) {
  console.error(`cannot run cargo (${result.error.message}); install the toolchain rust/rust-toolchain.toml names`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status || 1);
// A reachable panic in the crate embeds its source path (`core\src\lib.rs` on Windows,
// `core/src/lib.rs` on Linux), so the module would no longer reproduce across machines. The
// prebuilt standard library's paths, its own and its dependencies', are remapped to /rustc/<hash>/
// and /cargo/registry/ when it is built, and are the same everywhere.
const sources = [...new Set(readFileSync(built).toString('latin1').match(/[\x20-\x7e]*\.rs\b/g) ?? [])]
  .filter(source => !source.startsWith('/rustc/') && !source.startsWith('/cargo/registry/'));
if (sources.length) {
  console.error(`the module embeds source paths, so it would differ between machines: ${sources.join(', ')}.\n` +
    'A panic in the crate is reachable from an export; make that path panic-free (docs/27).');
  process.exit(1);
}
if (process.argv.includes('--check')) {
  if (!readFileSync(built).equals(readFileSync(committed))) {
    console.error(`${committed} is not what rust/core builds to; run npm run core:build and commit it`);
    process.exit(1);
  }
  console.log(`${committed} matches the build`);
} else {
  copyFileSync(built, committed);
  console.log(`built ${committed}`);
}
