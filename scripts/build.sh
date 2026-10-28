#!/usr/bin/env bash
set -euo pipefail

echo "=== Building Vimium-RS Core & WASM Packages ==="

mkdir -p extension/dist dist

# 1. Run workspace unit and integration tests
echo "-> Running workspace unit tests..."
cargo test --workspace

# 2. Build content and background crates for wasm32-unknown-unknown
echo "-> Building vimium-content and vimium-background for wasm32-unknown-unknown..."
cargo build -p vimium-content -p vimium-background --target wasm32-unknown-unknown --release

# 3. Copy WASM binaries to extension/dist
cp target/wasm32-unknown-unknown/release/vimium_content.wasm extension/dist/vimium_content_bg.wasm
cp target/wasm32-unknown-unknown/release/vimium_background.wasm extension/dist/vimium_background_bg.wasm
echo "✓ Copied WASM binaries to extension/dist/"

# 4. Package Chrome (.zip) and Firefox (.xpi) MV3 archives
python3 - <<'EOF'
import os, zipfile

def create_archive(archive_path):
    with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk('extension'):
            for f in sorted(files):
                full_path = os.path.join(root, f)
                rel_path = os.path.relpath(full_path, 'extension')
                zf.write(full_path, rel_path)

create_archive('dist/vimium-rs-chrome-mv3.zip')
create_archive('dist/vimium-rs-firefox-mv3.xpi')
EOF
echo "✓ Packaged dist/vimium-rs-chrome-mv3.zip and dist/vimium-rs-firefox-mv3.xpi"

# 5. Run Node.js end-to-end integration & packaging tests
echo "-> Running Node.js integration tests..."
node --test tests/*.test.mjs

echo "=== Build & Verification Complete! ==="
