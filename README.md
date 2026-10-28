# Vimium-RS

High-performance keyboard navigation and link hinting for **Chrome/Chromium** and **Firefox (Hellfire)**, rewritten in **Rust** and **WebAssembly** (Manifest V3).

Inspired by [Vimium C](https://github.com/gdh1995/vimium-c) and [qhints-rs](https://github.com/smllb/qhints-rs).

## Architecture

- **`crates/core`** — Pure Rust core engine:
  - Optimal $M$-ary prefix-free link hint tree generation & collision avoidance (`HintGenerator`, `HintSession`).
  - Flat-arena key sequence trie (`KeyTrie`), strict Vim count prefix handling, URL glob exclusion filter (`ExclusionFilter`), and modal state stack (`KeySequenceEngine`).
  - Cache-aligned zero-copy linear memory structs (`CandidateElementRecord` 32B, `HintMarkerLayout` 24B).
- **`crates/content`** — Zero-import C-ABI WASM content engine running in the browser's Isolated World.
- **`crates/background`** — Stateless MV3 service worker WASM helper for cross-frame hint partitioning.
- **`extension/`** — Hybrid JS DOM bridge with persistent Shadow DOM marker pooling, `translate3d` GPU positioning, and a 120Hz `requestAnimationFrame` smooth scroller.

## Build & Test

```bash
./scripts/build.sh
```

This runs all Rust unit/integration tests, compiles the `wasm32-unknown-unknown` binaries, packages Chrome (`.zip`) and Firefox (`.xpi`) bundles under `dist/`, and executes end-to-end browser tests in headless Chromium and Hellfire (Firefox).

## Installation

- **Firefox / Hellfire**: Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on...** → select `extension/manifest.json` (or `dist/vimium-rs-firefox-mv3.xpi`).
- **Chrome / Chromium**: Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder.

## Default Keybindings

| Key | Action |
| :--- | :--- |
| `j` / `k` / `h` / `l` | Scroll down / up / left / right |
| `d` / `u` | Scroll half-page down / up |
| `gg` / `G` | Scroll to top / bottom |
| `f` / `F` | Open link hints in current tab / new tab |
| `yf` / `yy` | Copy link URL / copy current page URL |
| `H` / `L` | History back / forward |
| `J` / `K` (`gT` / `gt`) | Previous / next tab |
| `t` / `x` / `X` | Create / close / restore tab |
| `i` / `v` / `Esc` | Insert mode / Visual mode / Exit to Normal mode |

## License

MIT
