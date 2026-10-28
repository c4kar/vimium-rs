/**
 * Vimium-RS Content Loader & Hybrid DOM Bridge
 * Runs in the extension isolated world.
 */

let wasmExports = null;
let shadowHost = null;
let shadowRoot = null;
let currentCandidates = [];

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
  let id = 1;

  for (const el of elements) {
    // Basic visibility checks
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

    candidates.push({
      element_id: id++,
      flags: 1, // CLICKABLE
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      weight: 10,
      element: el,
    });
  }

  currentCandidates = candidates;
  return candidates;
}

// Display Link Hints using Shadow DOM
function showHints() {
  if (!shadowHost) {
    shadowHost = document.createElement("div");
    shadowHost.id = "vimium-rs-hints-container";
    shadowHost.style.position = "absolute";
    shadowHost.style.top = "0";
    shadowHost.style.left = "0";
    shadowHost.style.zIndex = "2147483647";
    shadowHost.style.pointerEvents = "none";
    shadowRoot = shadowHost.attachShadow({ mode: "open" });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("styles/hints.css");
    shadowRoot.appendChild(link);

    document.documentElement.appendChild(shadowHost);
  }

  const candidates = collectCandidates();
  // Clear existing badges
  const existingBadges = shadowRoot.querySelectorAll(".vimium-hint-marker");
  existingBadges.forEach(b => b.remove());

  // In production, candidates are passed into WASM memory and HintMarkerLayout is read back.
  for (const cand of candidates) {
    const marker = document.createElement("div");
    marker.className = "vimium-hint-marker";
    marker.style.left = `${cand.x + window.scrollX}px`;
    marker.style.top = `${cand.y + window.scrollY}px`;
    marker.textContent = "F"; // Placeholder for generated hint label
    shadowRoot.appendChild(marker);
  }
}

function hideHints() {
  if (shadowRoot) {
    const existingBadges = shadowRoot.querySelectorAll(".vimium-hint-marker");
    existingBadges.forEach(b => b.remove());
  }
}

// Key interception
window.addEventListener("keydown", (e) => {
  // Pass through if active element is text editable
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
