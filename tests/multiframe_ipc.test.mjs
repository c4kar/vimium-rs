import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

test("Stateless service worker coordinates two-phase multi-frame hint handshake and tab broadcasts", async () => {
  const sessionStore = {};
  const tabMessages = [];
  const tabOps = [];
  let messageListener = null;

  const wasmPath = path.resolve("extension/dist/vimium_background_bg.wasm");
  const hasBgWasm = fs.existsSync(wasmPath);
  const wasmBytes = hasBgWasm ? fs.readFileSync(wasmPath) : null;

  const context = {
    console,
    setTimeout,
    clearTimeout,
    Uint32Array,
    WebAssembly: wasmBytes
      ? {
          instantiateStreaming: async () => WebAssembly.instantiate(wasmBytes, {}),
          instantiate: async (bytes, imports) => WebAssembly.instantiate(bytes, imports),
        }
      : WebAssembly,
    fetch: async () => ({
      arrayBuffer: async () => wasmBytes,
    }),
    chrome: {
      runtime: {
        getURL: (p) => p,
        onInstalled: {
          addListener: () => {},
        },
        onMessage: {
          addListener: (fn) => {
            messageListener = fn;
          },
        },
      },
      storage: {
        session: {
          get: async (keys) => {
            if (typeof keys === "string") {
              return { [keys]: sessionStore[keys] };
            }
            return { ...sessionStore };
          },
          set: async (items) => {
            Object.assign(sessionStore, items);
          },
        },
      },
      tabs: {
        sendMessage: async (tabId, msg, opts) => {
          tabMessages.push({ tabId, msg, opts });
        },
        create: async (opts) => {
          tabOps.push({ op: "create", opts });
        },
        remove: async (tabId) => {
          tabOps.push({ op: "remove", tabId });
        },
      },
    },
  };

  const swCode = fs.readFileSync(
    path.resolve("extension/background/service_worker.js"),
    "utf8"
  );
  vm.createContext(context);
  vm.runInContext(swCode, context);

  assert.ok(messageListener, "Service worker registered runtime.onMessage listener");

  // 1. Frame 0 initiates REQUEST_TAB_HINTS for tab 42 with expectedFrames = 2
  await new Promise((resolve) => {
    messageListener(
      { type: "REQUEST_TAB_HINTS", actionCode: 1, expectedFrames: 2 },
      { tab: { id: 42 }, frameId: 0 },
      resolve
    );
  });

  assert.equal(tabMessages.length, 1);
  assert.equal(tabMessages[0].tabId, 42);
  assert.equal(tabMessages[0].msg.type, "COLLECT_FRAME_HINTS");

  // 2. Frame 0 reports 10 candidates
  await new Promise((resolve) => {
    messageListener(
      { type: "REPORT_FRAME_COUNT", count: 10 },
      { tab: { id: 42 }, frameId: 0 },
      resolve
    );
  });

  // 3. Frame 105 reports 6 candidates -> completes expectedFrames=2, triggers RENDER_FRAME_HINTS
  await new Promise((resolve) => {
    messageListener(
      { type: "REPORT_FRAME_COUNT", count: 6 },
      { tab: { id: 42 }, frameId: 105 },
      resolve
    );
  });

  const renderMsg = tabMessages.find((m) => m.msg.type === "RENDER_FRAME_HINTS");
  assert.ok(renderMsg, "Should broadcast RENDER_FRAME_HINTS once all frames report");
  assert.equal(renderMsg.msg.totalCount, 16);
  assert.deepEqual({ ...renderMsg.msg.frameOffsets }, {
    0: 0,
    105: 10,
  });

  // 4. Keystroke broadcast during active cross-frame hint session
  await new Promise((resolve) => {
    messageListener(
      { type: "HINT_KEYSTROKE", keyByte: 115 },
      { tab: { id: 42 }, frameId: 0 },
      resolve
    );
  });
  const keyMsg = tabMessages.find((m) => m.msg.type === "HINT_KEYSTROKE_BROADCAST");
  assert.ok(keyMsg, "Should broadcast HINT_KEYSTROKE_BROADCAST to all frames in tab");
  assert.equal(keyMsg.msg.keyByte, 115);

  // 5. Dismiss broadcast
  await new Promise((resolve) => {
    messageListener(
      { type: "DISMISS_HINTS" },
      { tab: { id: 42 }, frameId: 105 },
      resolve
    );
  });
  const dismissMsg = tabMessages.find((m) => m.msg.type === "DISMISS_HINTS_BROADCAST");
  assert.ok(dismissMsg, "Should broadcast DISMISS_HINTS_BROADCAST to all frames in tab");
});
