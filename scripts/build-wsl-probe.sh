#!/usr/bin/env bash
# Build-time tooling only; no compiler/runtime is required in the user's WSL.
set -euo pipefail
cd "$(dirname "$0")/.."
export RUSTFLAGS="-C target-feature=+crt-static"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-target/wsl-probe}"
cargo build --locked -p laymux-wsl-codex-probe -p laymux-agent-hook --release --target x86_64-unknown-linux-gnu
probe="$CARGO_TARGET_DIR/x86_64-unknown-linux-gnu/release/laymux-wsl-codex-probe"
# Reject accidental dynamic libc/SQLite/runtime dependencies before packaging.
if readelf -l "$probe" | grep -q INTERP || readelf -d "$probe" | grep -q NEEDED; then
    echo "WSL probe must be a static Linux executable" >&2
    exit 1
fi
mkdir -p src-tauri/gen/wsl
cp "$probe" src-tauri/gen/wsl/laymux-wsl-codex-probe
hook="$CARGO_TARGET_DIR/x86_64-unknown-linux-gnu/release/laymux-agent-hook"
if readelf -l "$hook" | grep -q INTERP || readelf -d "$hook" | grep -q NEEDED; then
    echo "WSL agent hook must be a static Linux executable" >&2
    exit 1
fi
cp "$hook" src-tauri/gen/wsl/laymux-agent-hook
