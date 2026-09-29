#!/usr/bin/env bash
# Builds self-contained executables of the promptreduce CLI for every desktop platform.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
build() { bun build --compile --minify --target="$1" src/cli.ts --outfile "dist/$2"; }
build bun-darwin-arm64  promptreduce-macos-arm64
build bun-darwin-x64    promptreduce-macos-x64
build bun-windows-x64   promptreduce-windows-x64.exe
build bun-linux-x64     promptreduce-linux-x64
ls -la dist
