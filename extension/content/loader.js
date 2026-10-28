/**
 * Vimium-RS Content Loader & Hybrid DOM Bridge
 * Runs in the extension isolated world.
 */

let wasmExports = null;
let shadowHost = null;
let shadowRoot = null;
// Transient array for O(1) element lookup by element_id
let currentElements = [];
let cachedCandidates = [];
let activeMarkers = [];
let activeLayoutsPtr = 0;
let activeLayoutsCount = 0;
let isHintModeActive = false;
let isMultiFrameSession = false;
let currentFrameId = 0;
let pendingSequenceTimer = null;

const INTERACTIVE_SELECTOR =
  "a[href], button, input, select, textarea, [tabindex], [role='button'], [role='link'], summary, [onclick], [contenteditable='true']";

// Initialize WASM Module
async function initWasm() {
  try {
    const wasmUrl = chrome.runtime.getURL("dist/vimium_content_bg.wasm");
    const response = await fetch(wasmUrl);
    let result;
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        result = await WebAssembly.instantiateStreaming(response, {});
      } catch (_) {
        const bytes = await response.arrayBuffer();
        result = await WebAssembly.instantiate(bytes, {});
      }
    } else {
      const bytes = await response.arrayBuffer();
      result = await WebAssembly.instantiate(bytes, {});
    }
    wasmExports = result.instance.exports;
    if (wasmExports.init_content_engine) {
      wasmExports.init_content_engine();
    }
  } catch (err) {
    console.error("[Vimium-RS] Failed to load WASM module in isolated world:", err);
  }
}

const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary"]);

function isInteractiveElement(el) {
  if (!el || typeof el !== "object") return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "a") {
    return Boolean(el.href || (typeof el.hasAttribute === "function" && el.hasAttribute("href")));
  }
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (el.isContentEditable) return true;
  if (typeof el.getAttribute === "function") {
    const role = el.getAttribute("role");
    if (role === "button" || role === "link") return true;
    if (el.getAttribute("tabindex") !== null || el.getAttribute("onclick") !== null) {
      return true;
    }
  }
  if (el.role === "button" || el.role === "link" || typeof el.onclick === "function") {
    return true;
  }
  return false;
}

function findFirstVisibleRect(el, vLeft, vTop, vRight, vBottom) {
  if (typeof el.getClientRects === "function") {
    const rects = el.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (
        r.width > 0 &&
        r.height > 0 &&
        r.right >= vLeft &&
        r.left <= vRight &&
        r.bottom >= vTop &&
        r.top <= vBottom
      ) {
        return r;
      }
    }
    return null;
  }

  const rect = el.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.right < vLeft ||
    rect.left > vRight ||
    rect.bottom < vTop ||
    rect.top > vBottom
  ) {
    return null;
  }
  return rect;
}

// Scans visible interactive DOM elements within viewport bounds
function collectCandidates() {
  const vLeft = 0;
  const vTop = 0;
  const vRight = window.innerWidth;
  const vBottom = window.innerHeight;

  const rawRoots = document.querySelectorAll("*");
  const elements = [];
  const seen = new Set();

  function collectFromRoot(root) {
    const matched = root.querySelectorAll(INTERACTIVE_SELECTOR);
    for (let i = 0; i < matched.length; i++) {
      const el = matched[i];
      if (!seen.has(el) && isInteractiveElement(el)) {
        seen.add(el);
        elements.push(el);
      }
      if (el.shadowRoot) {
        collectFromRoot(el.shadowRoot);
      }
    }
  }

  collectFromRoot(document);
  for (let i = 0; i < rawRoots.length; i++) {
    const node = rawRoots[i];
    if (node && node.shadowRoot) {
      collectFromRoot(node.shadowRoot);
    }
  }

  const candidates = [];
  currentElements = [];

  const occlusionStart = typeof performance !== "undefined" ? performance.now() : 0;
  const OCCLUSION_BUDGET_MS = 5.0;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const rect = findFirstVisibleRect(el, vLeft, vTop, vRight, vBottom);
    if (!rect) {
      continue;
    }

    // Lazy computed style check after geometry culling
    if (typeof window.getComputedStyle === "function") {
      const style = window.getComputedStyle(el);
      if (
        style &&
        (style.visibility === "hidden" ||
          style.display === "none" ||
          parseFloat(style.opacity) === 0)
      ) {
        continue;
      }
    }

    // 5ms time-budgeted center-point occlusion check
    if (
      typeof document.elementFromPoint === "function" &&
      typeof performance !== "undefined" &&
      performance.now() - occlusionStart < OCCLUSION_BUDGET_MS
    ) {
      const cx = Math.min(Math.max(rect.left + rect.width * 0.5, 0), vRight - 1);
      const cy = Math.min(Math.max(rect.top + rect.height * 0.5, 0), vBottom - 1);
      const hit = document.elementFromPoint(cx, cy);
      if (
        hit &&
        hit !== el &&
        typeof el.contains === "function" &&
        !el.contains(hit) &&
        typeof hit.contains === "function" &&
        !hit.contains(el)
      ) {
        continue;
      }
    }

    const elementId = currentElements.length;
    currentElements.push(el);

    let flags = 1; // CLICKABLE
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || el.isContentEditable) {
      flags |= 2; // EDITABLE
    }

    candidates.push({
      element_id: elementId,
      flags,
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

function renderMarkerText(marker, labelStr, matchedLen) {
  if (matchedLen <= 0) {
    marker.textContent = labelStr;
    return;
  }
  const matchedPart = labelStr.slice(0, matchedLen);
  const restPart = labelStr.slice(matchedLen);
  marker.innerHTML = `<span class="vimium-hint-matched">${matchedPart}</span>${restPart}`;
}

// Display Link Hints using direct WASM linear memory transfer
function showHints(actionCode = 1, preCollected = null, totalCount = 0, offset = 0) {
  ensureShadowContainer();
  hideHints();

  const candidates = preCollected || collectCandidates();
  if (
    candidates.length === 0 ||
    !wasmExports ||
    !wasmExports.allocate_candidates_buffer
  ) {
    return;
  }

  // 1. Allocate reusable buffer in WASM linear memory
  const count = candidates.length;
  const ptr = wasmExports.allocate_candidates_buffer(count);

  // 2. Populate 32-byte structs directly in WASM memory
  // CandidateElementRecord: element_id(u32), flags(u32), x(f32), y(f32), width(f32), height(f32), weight(u16), _pad(u16)
  const mem = wasmExports.memory.buffer;
  const u32View = new Uint32Array(mem, ptr, count * 8);
  const f32View = new Float32Array(mem, ptr, count * 8);

  for (let i = 0; i < count; i++) {
    const offsetIdx = i * 8;
    const c = candidates[i];
    u32View[offsetIdx + 0] = c.element_id;
    u32View[offsetIdx + 1] = c.flags;
    f32View[offsetIdx + 2] = c.x;
    f32View[offsetIdx + 3] = c.y;
    f32View[offsetIdx + 4] = c.width;
    f32View[offsetIdx + 5] = c.height;
    u32View[offsetIdx + 6] = c.weight & 0xffff;
  }

  // 3. Start interactive hint session in Rust Core (supporting multi-frame offset/total)
  const effectiveTotal = totalCount > 0 ? totalCount : count;
  const layoutsPtr = wasmExports.start_hint_session_range
    ? wasmExports.start_hint_session_range(ptr, count, actionCode, effectiveTotal, offset)
    : wasmExports.start_hint_session
      ? wasmExports.start_hint_session(ptr, count, actionCode)
      : wasmExports.compute_hint_layouts(ptr, count);
  const layoutsCount = wasmExports.get_layouts_count();

  activeLayoutsPtr = layoutsPtr;
  activeLayoutsCount = layoutsCount;
  isHintModeActive = true;
  activeMarkers = [];

  // 4. Read back 24-byte HintMarkerLayout structs
  // HintMarkerLayout: element_id(u32), x(f32), y(f32), label_len(u8), label([u8; 7]), flags(u32)
  const freshMem = wasmExports.memory.buffer;
  const layoutU32 = new Uint32Array(freshMem, layoutsPtr, layoutsCount * 6);
  const layoutF32 = new Float32Array(freshMem, layoutsPtr, layoutsCount * 6);
  const layoutU8 = new Uint8Array(freshMem, layoutsPtr, layoutsCount * 24);

  const fragment = document.createDocumentFragment();
  const decoder = new TextDecoder();

  for (let i = 0; i < layoutsCount; i++) {
    const u32Offset = i * 6;
    const byteOffset = i * 24;

    const elementId = layoutU32[u32Offset + 0];
    const x = layoutF32[u32Offset + 1];
    const y = layoutF32[u32Offset + 2];
    const labelLen = layoutU8[byteOffset + 12];
    const labelBytes = layoutU8.subarray(
      byteOffset + 13,
      byteOffset + 13 + labelLen
    );
    const labelStr = decoder.decode(labelBytes);

    const marker = document.createElement("div");
    marker.className = "vimium-hint-marker";
    marker.style.left = `${x + window.scrollX}px`;
    marker.style.top = `${y + window.scrollY}px`;
    marker.dataset.elementId = String(elementId);
    marker.dataset.label = labelStr;
    marker.textContent = labelStr;

    activeMarkers.push(marker);
    fragment.appendChild(marker);
  }

  shadowRoot.appendChild(fragment);
}

function updateMarkersFromWasm(matchedLen) {
  if (!wasmExports || !activeLayoutsPtr || activeLayoutsCount === 0) return;

  const mem = wasmExports.memory.buffer;
  const layoutU32 = new Uint32Array(
    mem,
    activeLayoutsPtr,
    activeLayoutsCount * 6
  );

  for (let i = 0; i < activeLayoutsCount; i++) {
    const flags = layoutU32[i * 6 + 5];
    const isHidden = (flags & 0x80000000) !== 0;
    const marker = activeMarkers[i];
    if (!marker) continue;

    if (isHidden) {
      marker.style.display = "none";
    } else {
      marker.style.display = "block";
      renderMarkerText(marker, marker.dataset.label || "", matchedLen);
    }
  }
}

function hideHints() {
  if (shadowRoot) {
    const existingBadges = shadowRoot.querySelectorAll(".vimium-hint-marker");
    existingBadges.forEach((b) => b.remove());
  }
  activeMarkers = [];
  activeLayoutsPtr = 0;
  activeLayoutsCount = 0;
  isHintModeActive = false;
  // Drop element references to allow GC
  currentElements = [];
}

// Dispatches the full Vimium C mouse event cascade or copies URL
function activateElement(elementId, actionCode = 1) {
  const el = currentElements[elementId];
  hideHints();

  if (!el) return;

  // Action 3: CopyLinkUrl ('yf')
  if (actionCode === 3) {
    const url = el.href || el.src || el.textContent || "";
    if (url && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).catch(() => {});
    }
    return;
  }

  const newTab = actionCode === 2;

  // If editable, focus directly
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || el.isContentEditable) {
    el.focus();
    if (
      tag === "input" &&
      (el.type === "text" || el.type === "search") &&
      typeof el.setSelectionRange === "function"
    ) {
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

function clearPendingTimer() {
  if (pendingSequenceTimer !== null) {
    clearTimeout(pendingSequenceTimer);
    pendingSequenceTimer = null;
  }
}

function armPendingTimer() {
  clearPendingTimer();
  pendingSequenceTimer = setTimeout(() => {
    pendingSequenceTimer = null;
    if (wasmExports && wasmExports.reset_key_state) {
      wasmExports.reset_key_state();
    }
  }, 1000);
}

function keyEventToByte(e) {
  if (e.key === "Escape") return 27;
  if (e.key === "Backspace") return 8;
  if (e.key && e.key.length === 1) return e.key.charCodeAt(0);
  return 0;
}

function keyEventModifiers(e) {
  let mods = 0;
  if (e.ctrlKey) mods |= 1;
  if (e.altKey) mods |= 2;
  if (e.metaKey) mods |= 4;
  // Only set SHIFT bit when accompanied by non-printable or Ctrl/Alt/Meta,
  // since uppercase ASCII ('F', 'G', 'H', 'J', 'K', 'X', 'P') already encodes Shift in the character byte.
  if (e.shiftKey && (!e.key || e.key.length !== 1)) {
    mods |= 8;
  }
  return mods;
}

// Key interception
window.addEventListener(
  "keydown",
  (e) => {
    const tag =
      document.activeElement && document.activeElement.tagName
        ? document.activeElement.tagName.toLowerCase()
        : "";
    if (
      tag === "input" ||
      tag === "textarea" ||
      (document.activeElement && document.activeElement.isContentEditable)
    ) {
      if (e.key === "Escape") {
        if (typeof document.activeElement.blur === "function") {
          document.activeElement.blur();
        }
        hideHints();
      }
      return;
    }

    const keyByte = keyEventToByte(e);
    if (keyByte === 0 || !wasmExports) return;

    // 1. If interactive HintSession is active, route directly to step_hint_session
    if (isHintModeActive && wasmExports.step_hint_session) {
      e.preventDefault();
      processHintStepByte(keyByte, true);
      return;
    }

    // 2. Standard KeySequenceEngine dispatch
    const mods = keyEventModifiers(e);
    const result = wasmExports.process_stroke_event
      ? wasmExports.process_stroke_event(keyByte, mods)
      : wasmExports.process_key_event(keyByte);

    if (result === 0) {
      // PassThrough
      clearPendingTimer();
      return;
    }

    if (result === 1) {
      // Pending prefix or count accumulator — arm 1000ms timeout
      e.preventDefault();
      armPendingTimer();
      return;
    }

    if (result === 2) {
      // Cancelled (Escape)
      clearPendingTimer();
      hideHints();
      return;
    }

    clearPendingTimer();
    const action = result >> 16;
    const count = result & 0xffff;

    if (action === 10) {
      // ScrollDown
      window.scrollBy({ top: 60 * count, behavior: "smooth" });
      e.preventDefault();
    } else if (action === 11) {
      // ScrollUp
      window.scrollBy({ top: -60 * count, behavior: "smooth" });
      e.preventDefault();
    } else if (action === 16) {
      // ScrollLeft
      window.scrollBy({ left: -60 * count, behavior: "smooth" });
      e.preventDefault();
    } else if (action === 17) {
      // ScrollRight
      window.scrollBy({ left: 60 * count, behavior: "smooth" });
      e.preventDefault();
    } else if (action === 12) {
      // ScrollPageDown
      window.scrollBy({
        top: window.innerHeight * 0.5 * count,
        behavior: "smooth",
      });
      e.preventDefault();
    } else if (action === 13) {
      // ScrollPageUp
      window.scrollBy({
        top: -window.innerHeight * 0.5 * count,
        behavior: "smooth",
      });
      e.preventDefault();
    } else if (action === 14) {
      // ScrollToTop
      window.scrollTo?.({ top: 0, behavior: "smooth" });
      e.preventDefault();
    } else if (action === 15) {
      // ScrollToBottom
      window.scrollTo?.({ top: 1e9, behavior: "smooth" });
      e.preventDefault();
    } else if (action === 20) {
      // LinkHints (current tab)
      showHints(1);
      e.preventDefault();
    } else if (action === 21) {
      // LinkHintsNewTab
      showHints(2);
      e.preventDefault();
    } else if (action === 71) {
      // CopyLinkUrl ('yf')
      showHints(3);
      e.preventDefault();
    } else if (action === 43) {
      // ExitMode (Esc)
      hideHints();
    }
  },
  true
);

// Start WASM initialization
initWasm();

function processHintStepByte(keyByte, broadcastToTab = true) {
  if (!isHintModeActive || !wasmExports || !wasmExports.step_hint_session) return;

  if (broadcastToTab && isMultiFrameSession) {
    chrome.runtime.sendMessage({ type: "HINT_KEYSTROKE", keyByte }).catch(() => {});
  }

  const stepRes = wasmExports.step_hint_session(keyByte);
  const status = (stepRes >> 28) & 0xf;

  if (status === 0 || status === 3) {
    if (broadcastToTab && isMultiFrameSession) {
      chrome.runtime.sendMessage({ type: "DISMISS_HINTS" }).catch(() => {});
    }
    hideHints();
  } else if (status === 1) {
    const matchedLen = (stepRes >> 16) & 0xff;
    updateMarkersFromWasm(matchedLen);
  } else if (status === 2) {
    const actionCode = (stepRes >> 24) & 0xf;
    const elementId = stepRes & 0x00ffffff;
    if (isMultiFrameSession) {
      chrome.runtime.sendMessage({ type: "DISMISS_HINTS" }).catch(() => {});
    }
    activateElement(elementId, actionCode);
  }
}

// Focus tracking across frames
window.addEventListener("focus", () => {
  chrome.runtime
    .sendMessage({ type: "FRAME_FOCUSED" })
    .then((res) => {
      if (res && typeof res.frameId === "number") {
        currentFrameId = res.frameId;
      }
    })
    .catch(() => {});
});

// Broadcast listener for cross-frame commands
chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;

  if (message.type === "DISMISS_HINTS_BROADCAST") {
    hideHints();
  } else if (message.type === "COLLECT_FRAME_HINTS") {
    cachedCandidates = collectCandidates();
    chrome.runtime
      .sendMessage({
        type: "REPORT_FRAME_COUNT",
        count: cachedCandidates.length,
      })
      .then((res) => {
        if (res && typeof res.frameId === "number") {
          currentFrameId = res.frameId;
        }
      })
      .catch(() => {});
  } else if (message.type === "RENDER_FRAME_HINTS") {
    const offset =
      message.frameOffsets && message.frameOffsets[currentFrameId] !== undefined
        ? message.frameOffsets[currentFrameId]
        : 0;
    isMultiFrameSession = true;
    showHints(
      message.actionCode || 1,
      cachedCandidates.length > 0 ? cachedCandidates : null,
      message.totalCount || 0,
      offset
    );
  } else if (message.type === "HINT_KEYSTROKE_BROADCAST") {
    processHintStepByte(message.keyByte, false);
  }
});
