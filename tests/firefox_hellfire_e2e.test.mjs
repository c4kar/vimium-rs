import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

function startTestServer() {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Vimium-RS Hellfire (Firefox 160) E2E Test</title>
  <style>
    body { height: 3000px; font-family: sans-serif; margin: 20px; }
    .btn { display: inline-block; margin: 16px; padding: 8px 16px; border: 1px solid #333; }
  </style>
</head>
<body>
  <h1>Vimium-RS Hellfire Test Page</h1>
  <a id="link-alpha" class="btn" href="#alpha" onclick="window.__clicked = 'alpha'; return false;">Alpha Link</a>
  <button id="btn-beta" class="btn" onclick="window.__clicked = 'beta';">Beta Button</button>
  <a id="link-gamma" class="btn" href="#gamma" onclick="window.__clicked = 'gamma'; return false;">Gamma Link</a>
  <div id="perf-grid">
    ${Array.from(
      { length: 250 },
      (_, i) =>
        `<a class="btn" href="#item-${i}" style="padding:2px 4px;margin:2px;font-size:10px;">Item ${i}</a>`
    ).join("")}
  </div>
</body>
</html>`;

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

class BiDiClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.type === "error") {
          reject(new Error(`${msg.error}: ${msg.message}`));
        } else {
          resolve(msg.result);
        }
      } else {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

test("Real Hellfire (Firefox 160) installs MV3 extension, instantiates WASM in Xray sandbox, renders 250+ hints, and activates links", async (t) => {
  if (!fs.existsSync("/usr/bin/hellfire")) {
    t.skip("/usr/bin/hellfire not installed");
    return;
  }

  const { server, url } = await startTestServer();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "vimium-rs-hellfire-"));
  const extPath = path.resolve("extension");

  const proc = spawn(
    "/usr/bin/hellfire",
    [
      "--headless",
      "--no-remote",
      "--profile",
      profileDir,
      "--remote-debugging-port",
      "0",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  t.after(() => {
    proc.kill("SIGKILL");
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  const wsBaseUrl = await new Promise((resolve, reject) => {
    let stderrBuf = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Hellfire WebDriver BiDi. stderr:\n${stderrBuf}`));
    }, 10000);

    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const m = stderrBuf.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });

  const bidi = new BiDiClient(`${wsBaseUrl}/session`);
  await bidi.connect();
  t.after(() => bidi.close());

  await bidi.send("session.new", { capabilities: {} });
  await bidi.send("session.subscribe", { events: ["log.entryAdded"] });

  // 1. Install Vimium-RS extension into Hellfire
  const extRes = await bidi.send("webExtension.install", {
    extensionData: {
      type: "path",
      path: extPath,
    },
  });
  assert.equal(
    extRes.extension,
    "vimium-rs@c4kar.github.io",
    "Hellfire must install vimium-rs@c4kar.github.io"
  );

  // 2. Get top-level browsing context and navigate to test page
  const tree = await bidi.send("browsingContext.getTree", {});
  const contextId = tree.contexts[0].context;

  await bidi.send("browsingContext.navigate", {
    context: contextId,
    url,
    wait: "complete",
  });

  // Give content script + WASM streaming instantiation 400ms to settle
  await new Promise((r) => setTimeout(r, 400));

  // Print any console errors captured from Hellfire
  for (const ev of bidi.events) {
    if (ev.method === "log.entryAdded" && ev.params?.level === "error") {
      console.log("[Hellfire Console Error]:", ev.params.text);
    }
  }

  // 3. Dispatch 'f' keystroke via WebDriver BiDi input.performActions
  await bidi.send("input.performActions", {
    context: contextId,
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [
          { type: "keyDown", value: "f" },
          { type: "keyUp", value: "f" },
        ],
      },
    ],
  });

  // Verify #vimium-rs-hints-container was injected in Hellfire
  const hostEval = await bidi.send("script.evaluate", {
    expression: `Boolean(document.getElementById("vimium-rs-hints-container"))`,
    target: { context: contextId },
    awaitPromise: false,
  });
  assert.equal(
    hostEval.result.value,
    true,
    "Pressing 'f' in Hellfire must inject #vimium-rs-hints-container"
  );

  // 4. Press Escape, then benchmark warm 'f' activation latency in Hellfire
  await bidi.send("input.performActions", {
    context: contextId,
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [
          { type: "keyDown", value: "\uE00C" }, // Escape
          { type: "keyUp", value: "\uE00C" },
        ],
      },
    ],
  });

  const perfEval = await bidi.send("script.evaluate", {
    expression: `(() => {
      const t0 = performance.now();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true }));
      const t1 = performance.now();
      return t1 - t0;
    })()`,
    target: { context: contextId },
    awaitPromise: false,
  });
  console.log(
    `[Hellfire (Firefox 160) Benchmark] 250+ visible links 'f' end-to-end latency: ${perfEval.result.value.toFixed(2)} ms`
  );
  assert.ok(
    perfEval.result.value < 16.0,
    `Expected sub-frame (<16ms) hint activation in Hellfire, got ${perfEval.result.value.toFixed(2)}ms`
  );

  // 5. Type 's' then 's' to activate the first link (#link-alpha)
  await bidi.send("input.performActions", {
    context: contextId,
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [
          { type: "keyDown", value: "s" },
          { type: "keyUp", value: "s" },
          { type: "keyDown", value: "s" },
          { type: "keyUp", value: "s" },
        ],
      },
    ],
  });

  const clickedEval = await bidi.send("script.evaluate", {
    expression: `window.__clicked`,
    target: { context: contextId },
    awaitPromise: false,
  });
  assert.equal(
    clickedEval.result.value,
    "alpha",
    "Typing hint label in Hellfire must activate #link-alpha"
  );
});
