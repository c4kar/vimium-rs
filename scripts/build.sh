#!/usr/bin/env bash
set -euo pipefail

echo "=== Building Vimium-RS Core & WASM Packages ==="

mkdir -p extension/dist

# Build core and run tests
echo "-> Running workspace unit tests..."
cargo test --workspace

# Build content crate for wasm32
echo "-> Building vimium-content for wasm32-unknown-unknown..."
cargo build -p vimium-content --target wasm32-unknown-unknown --release

# Copy or generate wasm glue
TARGET_WASM="target/wasm32-unknown-unknown/release/vimium_content.wasm"
if [ -f "$TARGET_WASM" ]; then
    cp "$TARGET_WASM" extension/dist/vimium_content_bg.wasm
    echo "✓ Copied WASM binary to extension/dist/vimium_content_bg.wasm"
fi

echo "=== Build Complete! Extension ready at ./extension ==="
