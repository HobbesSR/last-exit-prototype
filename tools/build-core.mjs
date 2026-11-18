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
