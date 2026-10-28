/**
 * Vimium-RS Service Worker (Background)
 * Runs in the extension background service worker context under Manifest V3.
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Vimium-RS] Extension installed successfully.");
});

// Listener for cross-frame commands and persistent state storage
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ status: "PONG" });
  }
  return true;
});
