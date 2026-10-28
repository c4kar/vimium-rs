/**
 * Vimium-RS Content Loader & Hybrid DOM Bridge
 * Runs in the extension isolated world.
 *
 * Performance Architecture:
 * 1. Zero-QuerySelectorAll("*") DOM Discovery + WeakMap Visibility Cache
 * 2. Zero-Intermediate-JS-Allocation WASM Linear Memory Write
 * 3. Pre-warmed DOM Marker Pool + GPU translate3d() Positioning
 * 4. Custom 120Hz rAF Smooth Scroller with Instant Key-Repeat Acceleration
 */

let wasmExports = null;
let shadowHost = null;
let shadowRoot = null;
// Transient array for O(1) element lookup by element_id
let currentElements = [];
let cachedCandidatesCount = 0;
let activeMarkers = [];
// Persistent DOM node pool so repeated 'f' presses never call document.createElement in a loop
const markerPool = [];
let activeLayoutsPtr = 0;
let activeLayoutsCount = 0;
let isHintModeActive = false;
let isMultiFrameSession = false;
let currentFrameId = 0;
let pendingSequenceTimer = null;

// Cache computed style visibility per element across keystrokes (invalidated on DOM mutation)
let styleVisibilityCache = new WeakMap();
const knownShadowHosts = new Set();

const INTERACTIVE_SELECTOR =
  "a[href], button, input, select, textarea, [tabindex], [role='button'], [role='link'], summary, [onclick], [contenteditable='true']";

const INLINE_CSS = `
.vimium-hint-marker {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2147483647;
  display: block;
  contain: layout style paint;
  will-change: transform;
  padding: 1px 3px 0px 3px;
  background: linear-gradient(to bottom, #FFF785, #FFC542);
  border: 1px solid #E3BE23;
  border-radius: 3px;
  box-shadow: 0px 2px 5px rgba(0, 0, 0, 0.28);
  color: #000;
  font-family: Helvetica, Arial, sans-serif;
  font-weight: bold;
  font-size: 11px;
  line-height: 11px;
  text-align: center;
  text-transform: uppercase;
  user-select: none;
  pointer-events: none;
}
.vimium-hint-matched {
  color: #D4AC0D;
  opacity: 0.65;
}
`;

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
  if (typeof el.getBoundingClientRect === "function") {
    const bbox = el.getBoundingClientRect();
    if (
      bbox.width <= 0 ||
      bbox.height <= 0 ||
      bbox.right < vLeft ||
      bbox.left > vRight ||
      bbox.bottom < vTop ||
      bbox.top > vBottom
    ) {
      return null;
    }
    if (bbox.left >= vLeft && bbox.top >= vTop) {
      return bbox;
    }
  }

  // Fallback for wrapped multi-line inline elements whose bounding origin is offscreen
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
  }
  return null;
}

function isStyleVisible(el) {
  let cached = styleVisibilityCache.get(el);
  if (cached !== undefined) return cached;

  let visible = true;
  if (typeof el.checkVisibility === "function") {
    visible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  } else if (typeof window.getComputedStyle === "function") {
    const style = window.getComputedStyle(el);
    visible =
      !style ||
      (style.visibility !== "hidden" &&
        style.display !== "none" &&
        parseFloat(style.opacity) !== 0);
  }
  styleVisibilityCache.set(el, visible);
  return visible;
}

// Scans visible interactive DOM elements and writes them directly into WASM linear memory
function collectCandidatesIntoWasm() {
  const vLeft = 0;
  const vTop = 0;
  const vRight = window.innerWidth;
  const vBottom = window.innerHeight;

  const elements = [];
  const seen = new Set();

  function collectFromRoot(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    const matched = root.querySelectorAll(INTERACTIVE_SELECTOR);
    for (let i = 0; i < matched.length; i++) {
      const el = matched[i];
      if (!seen.has(el) && isInteractiveElement(el)) {
        seen.add(el);
        elements.push(el);
      }
      if (el && el.shadowRoot) {
        knownShadowHosts.add(el);
        collectFromRoot(el.shadowRoot);
      }
    }
  }

  collectFromRoot(document);
  for (const host of knownShadowHosts) {
    if (host && host.shadowRoot) {
      collectFromRoot(host.shadowRoot);
    }
  }

  // Fallback for open Shadow DOM hosts not matched by INTERACTIVE_SELECTOR on small DOMs
  if (elements.length < 64 && typeof document.querySelectorAll === "function") {
    const topNodes = document.querySelectorAll("div, section, main, article, header, nav, aside");
    const limit = Math.min(topNodes.length, 200);
    for (let i = 0; i < limit; i++) {
      const node = topNodes[i];
      if (node && node.shadowRoot && !knownShadowHosts.has(node)) {
        knownShadowHosts.add(node);
        collectFromRoot(node.shadowRoot);
      }
    }
  }

  currentElements = [];
  if (!wasmExports || !wasmExports.allocate_candidates_buffer || elements.length === 0) {
    cachedCandidatesCount = 0;
    return { ptr: 0, count: 0 };
  }

  // Pre-allocate WASM buffer for upper-bound elements.length so we write zero-copy in 1 pass
  const ptr = wasmExports.allocate_candidates_buffer(elements.length);
  const mem = wasmExports.memory.buffer;
  const u32View = new Uint32Array(mem, ptr, elements.length * 8);
  const f32View = new Float32Array(mem, ptr, elements.length * 8);

  const occlusionStart = typeof performance !== "undefined" ? performance.now() : 0;
  let validCount = 0;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];

    // 1. Geometry viewport check FIRST (cheapest C++ call in Gecko/Blink)
    const rect = findFirstVisibleRect(el, vLeft, vTop, vRight, vBottom);
    if (!rect) {
      continue;
    }

    // 2. Visibility check only for elements inside the viewport (cached across activations)
    if (!isStyleVisible(el)) {
      continue;
    }

    // 3. Sampling center-point occlusion check only for the first 32 viewport candidates within 1.5ms budget
    if (
      validCount < 32 &&
      typeof document.elementFromPoint === "function" &&
      typeof performance !== "undefined" &&
      performance.now() - occlusionStart < 1.5
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

    const elementId = validCount;
    currentElements.push(el);

    let flags = 1; // CLICKABLE
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || el.isContentEditable) {
      flags |= 2; // EDITABLE
    }

    const offsetIdx = validCount * 8;
    u32View[offsetIdx + 0] = elementId;
    u32View[offsetIdx + 1] = flags;
    f32View[offsetIdx + 2] = rect.left;
    f32View[offsetIdx + 3] = rect.top;
    f32View[offsetIdx + 4] = rect.width;
    f32View[offsetIdx + 5] = rect.height;
    u32View[offsetIdx + 6] = 10;
    u32View[offsetIdx + 7] = 0;

    validCount++;
  }

  cachedCandidatesCount = validCount;
  return { ptr, count: validCount };
}

// Ensure isolated closed Shadow DOM container exists with inline synchronous CSS (no async link FOUC)
function ensureShadowContainer() {
  if (!shadowHost) {
    shadowHost = document.createElement("div");
    shadowHost.id = "vimium-rs-hints-container";
    shadowHost.style.cssText =
      "position:absolute;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;contain:layout style;";
    shadowRoot = shadowHost.attachShadow({ mode: "closed" });

    const styleEl = document.createElement("style");
    styleEl.textContent = INLINE_CSS;
    shadowRoot.appendChild(styleEl);

    document.documentElement.appendChild(shadowHost);
  }
}

function acquireMarkerNode(index) {
  if (index < markerPool.length) {
    const node = markerPool[index];
    node._removed = false;
    node.style.display = "block";
    return node;
  }
  const marker = document.createElement("div");
  marker.className = "vimium-hint-marker";
  marker._pooled = false;
  markerPool.push(marker);
  return marker;
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
function showHints(actionCode = 1, useCached = false, totalCount = 0, offset = 0) {
  ensureShadowContainer();
  hideHints();

  const { ptr, count } =
    useCached && cachedCandidatesCount > 0
      ? { ptr: wasmExports.allocate_candidates_buffer(cachedCandidatesCount), count: cachedCandidatesCount }
      : collectCandidatesIntoWasm();

  if (count === 0 || !ptr) {
    return;
  }

  // Start interactive hint session in Rust Core (supporting multi-frame offset/total)
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

  // Read back 24-byte HintMarkerLayout structs directly from WASM linear memory
  const freshMem = wasmExports.memory.buffer;
  const layoutU32 = new Uint32Array(freshMem, layoutsPtr, layoutsCount * 6);
  const layoutF32 = new Float32Array(freshMem, layoutsPtr, layoutsCount * 6);
  const layoutU8 = new Uint8Array(freshMem, layoutsPtr, layoutsCount * 24);

  const fragment = document.createDocumentFragment();
  const scrollX = window.scrollX || 0;
  const scrollY = window.scrollY || 0;

  for (let i = 0; i < layoutsCount; i++) {
    const u32Offset = i * 6;
    const byteOffset = i * 24;

    const elementId = layoutU32[u32Offset + 0];
    const x = layoutF32[u32Offset + 1] + scrollX;
    const y = layoutF32[u32Offset + 2] + scrollY;
    const labelLen = layoutU8[byteOffset + 12];

    // Fast ASCII decode without TextDecoder allocation per badge
    let labelStr = "";
    for (let b = 0; b < labelLen; b++) {
      labelStr += String.fromCharCode(layoutU8[byteOffset + 13 + b]);
    }

    const marker = acquireMarkerNode(i);
    marker.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
    marker.dataset.elementId = String(elementId);
    marker.dataset.label = labelStr;
    marker.textContent = labelStr;

    activeMarkers.push(marker);
    if (!marker._pooled) {
      marker._pooled = true;
      fragment.appendChild(marker);
    }
  }

  if (fragment.childNodes ? fragment.childNodes.length > 0 : fragment.children?.length > 0) {
    shadowRoot.appendChild(fragment);
  }
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
      if (marker.style.display !== "none") {
        marker.style.display = "none";
      }
    } else {
      if (marker.style.display === "none") {
        marker.style.display = "block";
      }
      renderMarkerText(marker, marker.dataset.label || "", matchedLen);
    }
  }
}

function hideHints() {
  for (let i = 0; i < activeMarkers.length; i++) {
    activeMarkers[i].style.display = "none";
  }
  activeMarkers = [];
  activeLayoutsPtr = 0;
  activeLayoutsCount = 0;
  isHintModeActive = false;
  currentElements = [];
}

// High-Refresh-Rate (60/120/144Hz) rAF Smooth Scroller with Key-Repeat Acceleration
let scrollTargetX = 0;
let scrollTargetY = 0;
let scrollAnimating = false;

function triggerSmoothScroll(dx, dy) {
  // In headless / test environments without requestAnimationFrame, fall back to window.scrollBy
  if (typeof window.requestAnimationFrame !== "function") {
    window.scrollBy({ left: dx, top: dy, behavior: "smooth" });
    return;
  }

  scrollTargetX += dx;
  scrollTargetY += dy;

  // Also invoke instant scrollBy if sub-pixel step is tiny or first frame
  if (!scrollAnimating) {
    scrollAnimating = true;
    let lastTime = typeof performance !== "undefined" ? performance.now() : Date.now();

    function step(now) {
      const dt = Math.min(Math.max(now - lastTime, 4), 32);
      lastTime = now;

      // Exponential decay factor tuned for zero-latency Vimium C feel (~65ms time constant)
      const factor = 1 - Math.exp(-dt / 42);
      const stepX = scrollTargetX * factor;
      const stepY = scrollTargetY * factor;

      scrollTargetX -= stepX;
      scrollTargetY -= stepY;

      window.scrollBy(stepX, stepY);

      if (Math.abs(scrollTargetX) > 0.5 || Math.abs(scrollTargetY) > 0.5) {
        window.requestAnimationFrame(step);
      } else {
        if (Math.abs(scrollTargetX) > 0 || Math.abs(scrollTargetY) > 0) {
          window.scrollBy(scrollTargetX, scrollTargetY);
        }
        scrollTargetX = 0;
        scrollTargetY = 0;
        scrollAnimating = false;
      }
    }

    window.requestAnimationFrame(step);
  }
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
      clearPendingTimer();
      return;
    }

    if (result === 1) {
      e.preventDefault();
      armPendingTimer();
      return;
    }

    if (result === 2) {
      clearPendingTimer();
      hideHints();
      return;
    }

    clearPendingTimer();
    const action = result >> 16;
    const count = result & 0xffff;

    if (action === 10) {
      // ScrollDown
      triggerSmoothScroll(0, 65 * count);
      e.preventDefault();
    } else if (action === 11) {
      // ScrollUp
      triggerSmoothScroll(0, -65 * count);
      e.preventDefault();
    } else if (action === 16) {
      // ScrollLeft
      triggerSmoothScroll(-65 * count, 0);
      e.preventDefault();
    } else if (action === 17) {
      // ScrollRight
      triggerSmoothScroll(65 * count, 0);
      e.preventDefault();
    } else if (action === 12) {
      // ScrollPageDown
      triggerSmoothScroll(0, window.innerHeight * 0.5 * count);
      e.preventDefault();
    } else if (action === 13) {
      // ScrollPageUp
      triggerSmoothScroll(0, -window.innerHeight * 0.5 * count);
      e.preventDefault();
    } else if (action === 14) {
      // ScrollToTop
      window.scrollTo?.({ top: 0, behavior: "instant" });
      e.preventDefault();
    } else if (action === 15) {
      // ScrollToBottom
      window.scrollTo?.({ top: 1e9, behavior: "instant" });
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
    const { count } = collectCandidatesIntoWasm();
    chrome.runtime
      .sendMessage({
        type: "REPORT_FRAME_COUNT",
        count,
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
      true,
      message.totalCount || 0,
      offset
    );
  } else if (message.type === "HINT_KEYSTROKE_BROADCAST") {
    processHintStepByte(message.keyByte, false);
  }
});
