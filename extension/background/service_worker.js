/**
 * Vimium-RS Service Worker (Background)
 * Runs in the extension background service worker context under Manifest V3.
 * Purely event-driven and stateless, backed by chrome.storage.session.
 */

let bgWasmExports = null;
const handshakeTimers = new Map();

async function initBackgroundWasm() {
  try {
    if (typeof fetch !== "function" || typeof WebAssembly === "undefined") return;
    const wasmUrl = chrome.runtime.getURL("dist/vimium_background_bg.wasm");
    const response = await fetch(wasmUrl);
    const bytes = await response.arrayBuffer();
    if (!bytes) return;
    const result = await WebAssembly.instantiate(bytes, {});
    bgWasmExports = result.instance.exports;
    if (bgWasmExports.init_background_worker) {
      bgWasmExports.init_background_worker();
    }
  } catch (_) {
    // Fallback to JS prefix offset summation if WASM binary is not yet loaded
  }
}

initBackgroundWasm();

async function getSessionValue(key, fallback) {
  try {
    const data = await chrome.storage.session.get(key);
    return data && data[key] !== undefined ? data[key] : fallback;
  } catch (_) {
    return fallback;
  }
}

async function setSessionValue(obj) {
  try {
    await chrome.storage.session.set(obj);
  } catch (_) {}
}

function computeFrameOffsets(frameCountsMap) {
  const entries = Object.entries(frameCountsMap);
  const frameIds = entries.map(([id]) => Number(id));
  const counts = entries.map(([, c]) => Number(c));

  if (
    bgWasmExports &&
    bgWasmExports.allocate_frame_counts_buffer &&
    bgWasmExports.compute_frame_offsets &&
    bgWasmExports.get_frame_offsets_ptr
  ) {
    const len = counts.length;
    const ptr = bgWasmExports.allocate_frame_counts_buffer(len);
    const mem = bgWasmExports.memory.buffer;
    const u32In = new Uint32Array(mem, ptr, len);
    for (let i = 0; i < len; i++) {
      u32In[i] = counts[i];
    }
    const totalCount = bgWasmExports.compute_frame_offsets(ptr, len);
    const outPtr = bgWasmExports.get_frame_offsets_ptr();
    const u32Out = new Uint32Array(bgWasmExports.memory.buffer, outPtr, len);
    const frameOffsets = {};
    for (let i = 0; i < len; i++) {
      frameOffsets[frameIds[i]] = u32Out[i];
    }
    return { totalCount, frameOffsets };
  }

  let totalCount = 0;
  const frameOffsets = {};
  for (let i = 0; i < frameIds.length; i++) {
    frameOffsets[frameIds[i]] = totalCount;
    totalCount += counts[i];
  }
  return { totalCount, frameOffsets };
}

async function finalizeTabHandshake(tabId) {
  if (handshakeTimers.has(tabId)) {
    clearTimeout(handshakeTimers.get(tabId));
    handshakeTimers.delete(tabId);
  }

  const handshakes = await getSessionValue("hintHandshakes", {});
  const state = handshakes[tabId];
  if (!state || state.dispatched) return;

  state.dispatched = true;
  await setSessionValue({ hintHandshakes: handshakes });

  const { totalCount, frameOffsets } = computeFrameOffsets(state.counts);
  await chrome.tabs.sendMessage(tabId, {
    type: "RENDER_FRAME_HINTS",
    actionCode: state.actionCode,
    totalCount,
    frameOffsets,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setSessionValue({
    activeFrames: {},
    hintHandshakes: {},
    settings: {
      scrollStep: 60,
      smoothScroll: true,
    },
  });
});

// Listener for typed message envelopes from content frames
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const frameId = sender && sender.frameId !== undefined ? sender.frameId : 0;

  if (!message || !message.type) return false;

  (async () => {
    switch (message.type) {
      case "FRAME_FOCUSED": {
        if (tabId !== null) {
          const activeFrames = await getSessionValue("activeFrames", {});
          activeFrames[tabId] = frameId;
          await setSessionValue({ activeFrames });
        }
        sendResponse({ status: "OK", frameId });
        break;
      }

      case "REQUEST_TAB_HINTS":
      case "BROADCAST_HINTS": {
        if (tabId !== null) {
          const actionCode = message.actionCode || 1;
          const expectedFrames = message.expectedFrames || 1;
          const handshakes = await getSessionValue("hintHandshakes", {});
          handshakes[tabId] = {
            actionCode,
            expectedFrames,
            counts: {},
            dispatched: false,
          };
          await setSessionValue({ hintHandshakes: handshakes });

          await chrome.tabs.sendMessage(tabId, {
            type: "COLLECT_FRAME_HINTS",
            actionCode,
          });

          // 35ms timeout for slow/unresponsive child frames
          const timer = setTimeout(() => {
            finalizeTabHandshake(tabId);
          }, 35);
          handshakeTimers.set(tabId, timer);
        }
        sendResponse({ status: "OK" });
        break;
      }

      case "REPORT_FRAME_COUNT": {
        if (tabId !== null) {
          const handshakes = await getSessionValue("hintHandshakes", {});
          const state = handshakes[tabId];
          if (state && !state.dispatched) {
            state.counts[frameId] = Number(message.count || 0);
            await setSessionValue({ hintHandshakes: handshakes });

            const reportedCount = Object.keys(state.counts).length;
            if (reportedCount >= state.expectedFrames) {
              await finalizeTabHandshake(tabId);
            }
          }
        }
        sendResponse({ status: "OK", frameId });
        break;
      }

      case "HINT_KEYSTROKE": {
        if (tabId !== null) {
          await chrome.tabs.sendMessage(tabId, {
            type: "HINT_KEYSTROKE_BROADCAST",
            keyByte: message.keyByte,
          });
        }
        sendResponse({ status: "OK" });
        break;
      }

      case "DISMISS_HINTS": {
        if (tabId !== null) {
          await chrome.tabs.sendMessage(tabId, {
            type: "DISMISS_HINTS_BROADCAST",
          });
        }
        sendResponse({ status: "OK" });
        break;
      }

      case "TAB_COMMAND": {
        if (message.command === "create") {
          await chrome.tabs.create({ url: message.url || "about:newtab" });
        } else if (message.command === "close" && tabId !== null) {
          await chrome.tabs.remove(tabId);
        }
        sendResponse({ status: "OK" });
        break;
      }

      default:
        sendResponse({ status: "UNKNOWN_TYPE" });
        break;
    }
  })();

  return true;
});
