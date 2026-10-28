/**
 * Vimium-RS Service Worker (Background)
 * Runs in the extension background service worker context under Manifest V3.
 * Purely event-driven and stateless, backed by chrome.storage.session.
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Vimium-RS] Background Service Worker installed.");
  // Initialize default session state
  chrome.storage.session.set({
    activeFrames: {}, // tabId -> activeFrameId
    settings: {
      scrollStep: 60,
      smoothScroll: true,
    }
  });
});

// Listener for typed message envelopes from content frames
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;
  const frameId = sender.frameId;

  if (!message || !message.type) return;

  switch (message.type) {
    case "FRAME_FOCUSED": {
      if (tabId !== null) {
        chrome.storage.session.get("activeFrames", (data) => {
          const activeFrames = data.activeFrames || {};
          activeFrames[tabId] = frameId;
          chrome.storage.session.set({ activeFrames });
        });
      }
      sendResponse({ status: "OK" });
      break;
    }

    case "DISMISS_HINTS": {
      // Tab-wide broadcast: dismiss hints in ALL frames of the sender's tab
      if (tabId !== null) {
        chrome.tabs.sendMessage(tabId, { type: "DISMISS_HINTS_BROADCAST" });
      }
      sendResponse({ status: "OK" });
      break;
    }

    case "BROADCAST_HINTS": {
      // Multi-frame handshake: trigger hint collection across all frames in tab
      if (tabId !== null) {
        chrome.tabs.sendMessage(tabId, { type: "COLLECT_FRAME_HINTS" });
      }
      sendResponse({ status: "OK" });
      break;
    }

    default:
      sendResponse({ status: "UNKNOWN_TYPE" });
      break;
  }

  return true; // Keep sendResponse open for async replies
});
