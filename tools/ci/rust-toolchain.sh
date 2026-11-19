#!/usr/bin/env bash
# Installs the Rust toolchain rust/rust-toolchain.toml names, for the CI jobs that build the core's WASM
# module (docs/27): rust.yml's, and ci.yml's verify and slow, whose tests tick through the core.
# rustup is bootstrapped only when the job's cache did not restore it.
set -euo pipefail
if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
fi
echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"
cd "$(dirname "$0")/../../rust"
"$HOME/.cargo/bin/rustup" toolchain install
