# Vimium-RS Agent Rules & Architectural Invariants

## 1. Zero-Import C-ABI WASM FFI
- We compile `crates/content` and `crates/background` directly via `cargo build --target wasm32-unknown-unknown --release` without `wasm-pack`.
- All exported WASM functions MUST use `#[unsafe(no_mangle)] pub extern "C" fn ...` and primitive C-ABI types (`u8`, `u32`, `usize`, `i32`, raw pointers). Do NOT add `#[wasm_bindgen]` or `web_sys::console` calls in WASM targets, as they introduce unresolved `__wbg_*` imports that break `WebAssembly.instantiate(bytes, {})`.

## 2. Zero-Copy Linear Memory Struct Alignment
- Every `#[repr(C)]` struct shared between Rust WASM and JS `TypedArray` views (`CandidateElementRecord` = 32 bytes / 8 `u32` words; `HintMarkerLayout` = 24 bytes / 6 `u32` words) MUST have explicit padding fields (`_pad`, `_reserved`) so its byte size is an exact multiple of 4/8 bytes matching the JS stride.
- Never reallocate or clone a `HintSession` layout `Vec` after returning `session.layouts_ptr()` to JS; mutate flags in place so the pointer remains valid for the entire session.

## 3. Browser DOM & Gecko (Hellfire) Performance Guardrails
- **Never call `document.querySelectorAll("*")` on the hot path**: Query `INTERACTIVE_SELECTOR` directly and track open `shadowRoot` hosts in `knownShadowHosts`.
- **Gecko Xray Wrapper Awareness**: Always run `getBoundingClientRect()` viewport culling BEFORE calling `el.checkVisibility()` or `getComputedStyle(el)`, and cache visibility results in a `WeakMap` (`styleVisibilityCache`).
- **Persistent Shadow DOM Marker Pool**: Never call `.remove()` or `document.createElement()` in a loop during `showHints()` / `hideHints()`. Reuse pooled `.vimium-hint-marker` nodes inside the closed Shadow Root with inline `<style>`, toggling `display: none` and positioning via `transform: translate3d(Xpx, Ypx, 0)`.
