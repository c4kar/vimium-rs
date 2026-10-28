/**
 * Vimium-RS Content Loader & Hybrid DOM Bridge
 * Runs in the extension isolated world.
 */

let wasmExports = null;
let shadowHost = null;
let shadowRoot = null;
// Transient array for O(1) element lookup by element_id
let currentElements = [];

// Initialize WASM Module
async function initWasm() {
  try {
    const wasmUrl = chrome.runtime.getURL("dist/vimium_content_bg.wasm");
    const response = await fetch(wasmUrl);
    const { instance } = await WebAssembly.instantiateStreaming(response, {
      "./vimium_content_bg.js": {
        __wbindgen_placeholder__: {}
      }
    });
    wasmExports = instance.exports;
    if (wasmExports.init_content_engine) {
      wasmExports.init_content_engine();
    }
  } catch (err) {
    console.error("[Vimium-RS] Failed to load WASM module in isolated world:", err);
  }
}

// Scans visible interactive DOM elements within viewport bounds
function collectCandidates() {
  const vLeft = 0;
  const vTop = 0;
  const vRight = window.innerWidth;
  const vBottom = window.innerHeight;

  const elements = document.querySelectorAll(
    "a[href], button, input, select, textarea, [tabindex], [role='button'], [role='link']"
  );

  const candidates = [];
  currentElements = [];

  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.right < vLeft ||
      rect.left > vRight ||
      rect.bottom < vTop ||
      rect.top > vBottom
    ) {
      continue;
    }

    // Optional 5ms budgeted occlusion check for ambiguous elements
    const elementId = currentElements.length;
    currentElements.push(el);

    candidates.push({
      element_id: elementId,
      flags: 1, // CLICKABLE
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      weight: 10,
    });
  }

  return candidates;
}

// Ensure isolated closed Shadow DOM container exists
function ensureShadowContainer() {
  if (!shadowHost) {
    shadowHost = document.createElement("div");
    shadowHost.id = "vimium-rs-hints-container";
    shadowHost.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none;";
    shadowRoot = shadowHost.attachShadow({ mode: "closed" });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("styles/hints.css");
    shadowRoot.appendChild(link);

    document.documentElement.appendChild(shadowHost);
  }
}

// Display Link Hints using direct WASM linear memory transfer
function showHints() {
  ensureShadowContainer();
  hideHints();

  const candidates = collectCandidates();
  if (candidates.length === 0 || !wasmExports || !wasmExports.allocate_candidates_buffer) {
    return;
  }

  // 1. Allocate buffer in WASM linear memory
  const count = candidates.length;
  const ptr = wasmExports.allocate_candidates_buffer(count);

  // 2. Populate 32-byte structs directly in WASM memory
  // CandidateElementRecord: element_id(u32), flags(u32), x(f32), y(f32), width(f32), height(f32), weight(u16), _pad(u16)
  const mem = wasmExports.memory.buffer;
  const u32View = new Uint32Array(mem, ptr, count * 8);
  const f32View = new Float32Array(mem, ptr, count * 8);

  for (let i = 0; i < count; i++) {
    const offset = i * 8;
    const c = candidates[i];
    u32View[offset + 0] = c.element_id;
    u32View[offset + 1] = c.flags;
    f32View[offset + 2] = c.x;
    f32View[offset + 3] = c.y;
    f32View[offset + 4] = c.width;
    f32View[offset + 5] = c.height;
    u32View[offset + 6] = c.weight & 0xffff;
  }

  // 3. Compute layouts in Rust Core
  const layoutsPtr = wasmExports.compute_hint_layouts(ptr, count);
  const layoutsCount = wasmExports.get_layouts_count();

  // 4. Read back 24-byte HintMarkerLayout structs
  // HintMarkerLayout: element_id(u32), x(f32), y(f32), label_len(u8), label([u8; 7]), flags(u32)
  const layoutU32 = new Uint32Array(mem, layoutsPtr, layoutsCount * 6);
  const layoutF32 = new Float32Array(mem, layoutsPtr, layoutsCount * 6);
  const layoutU8 = new Uint8Array(mem, layoutsPtr, layoutsCount * 24);

  const fragment = document.createDocumentFragment();

  for (let i = 0; i < layoutsCount; i++) {
    const u32Offset = i * 6;
    const byteOffset = i * 24;

    const elementId = layoutU32[u32Offset + 0];
    const x = layoutF32[u32Offset + 1];
    const y = layoutF32[u32Offset + 2];
    const labelLen = layoutU8[byteOffset + 12];
    const labelBytes = layoutU8.subarray(byteOffset + 13, byteOffset + 13 + labelLen);
    const labelStr = new TextDecoder().decode(labelBytes);

    const marker = document.createElement("div");
    marker.className = "vimium-hint-marker";
    marker.style.left = `${x + window.scrollX}px`;
    marker.style.top = `${y + window.scrollY}px`;
    marker.dataset.elementId = String(elementId);
    marker.textContent = labelStr;

    fragment.appendChild(marker);
  }

  shadowRoot.appendChild(fragment);
}

function hideHints() {
  if (shadowRoot) {
    const existingBadges = shadowRoot.querySelectorAll(".vimium-hint-marker");
    existingBadges.forEach(b => b.remove());
  }
  // Drop element references to allow GC
  currentElements = [];
}

// Dispatches the full Vimium C mouse event cascade
function activateElement(elementId, newTab = false) {
  const el = currentElements[elementId];
  hideHints();

  if (!el) return;

  // If editable, focus directly
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || el.isContentEditable) {
    el.focus();
    if (tag === "input" && (el.type === "text" || el.type === "search")) {
      el.setSelectionRange(el.value.length, el.value.length);
    }
    return;
  }

  // Full event simulation sequence
  const mouseOpts = {
    bubbles: true,
    cancelable: true,
    view: window,
    ctrlKey: newTab,
    metaKey: newTab,
  };

  el.dispatchEvent(new MouseEvent("mouseover", mouseOpts));
  el.dispatchEvent(new MouseEvent("mousedown", mouseOpts));
  if (typeof el.focus === "function") {
    el.focus();
  }
  el.dispatchEvent(new MouseEvent("mouseup", mouseOpts));
  el.dispatchEvent(new MouseEvent("click", mouseOpts));
}

// Key interception
window.addEventListener("keydown", (e) => {
  const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || (document.activeElement && document.activeElement.isContentEditable)) {
    if (e.key === "Escape") {
      document.activeElement.blur();
      hideHints();
    }
    return;
  }

  if (wasmExports && wasmExports.process_key_event) {
    const keyCode = e.key.charCodeAt(0);
    const result = wasmExports.process_key_event(keyCode);

    const action = result >> 16;
    const count = result & 0xFFFF;

    if (action === 10) { // ScrollDown
      window.scrollBy({ top: 60 * count, behavior: "smooth" });
      e.preventDefault();
    } else if (action === 11) { // ScrollUp
      window.scrollBy({ top: -60 * count, behavior: "smooth" });
      e.preventDefault();
    } else if (action === 20) { // LinkHints
      showHints();
      e.preventDefault();
    } else if (action === 43) { // ExitMode (Esc)
      hideHints();
    }
  }
}, true);

// Start WASM initialization
initWasm();
