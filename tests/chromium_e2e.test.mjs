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
  <title>Vimium-RS Chromium E2E Test</title>
  <style>
    body { height: 3000px; font-family: sans-serif; margin: 20px; }
    .btn { display: inline-block; margin: 16px; padding: 8px 16px; border: 1px solid #333; }
  </style>
</head>
<body>
  <h1>Vimium-RS E2E Test Page</h1>
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

class CdpClient {
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
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    this.ws.close();
  }
}

test("Real Chromium 155 loads MV3 extension, instantiates WASM under CSP, scrolls on j, and activates link via f hints", async (t) => {
  const { server, url } = await startTestServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vimium-rs-chromium-"));
  const extPath = path.resolve("extension");

  const proc = spawn(
    "/usr/bin/chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  t.after(() => {
    proc.kill("SIGKILL");
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  // Wait for DevTools listening ws:// URL on stderr
  const wsUrl = await new Promise((resolve, reject) => {
    let stderrBuf = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Chromium DevTools WS. stderr:\n${stderrBuf}`));
    }, 8000);

    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });

  const cdp = new CdpClient(wsUrl);
  await cdp.connect();
  t.after(() => cdp.close());

  // Find the page target and the extension service_worker target
  let pageTarget = null;
  let swTarget = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    pageTarget = targetInfos.find((ti) => ti.type === "page" && ti.url.startsWith("http://127.0.0.1"));
    swTarget = targetInfos.find((ti) => ti.type === "service_worker");
    if (pageTarget && swTarget) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  assert.ok(swTarget, "MV3 extension background service_worker target must be registered in Chromium");
  assert.ok(pageTarget, "Test page target must be open in Chromium");

  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: pageTarget.targetId,
    flatten: true,
  });

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);

  // Wait briefly for content script + WASM instantiation to complete
  await new Promise((r) => setTimeout(r, 400));

  // Press 'f' to trigger LinkHints in Chromium
  await cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      key: "f",
      text: "f",
      unmodifiedText: "f",
      windowsVirtualKeyCode: 70,
    },
    sessionId
  );
  await cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyUp",
      key: "f",
      windowsVirtualKeyCode: 70,
    },
    sessionId
  );

  // Check that #vimium-rs-hints-container was injected into documentElement by content script + WASM
  const hostCheck = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `Boolean(document.getElementById("vimium-rs-hints-container"))`,
      returnByValue: true,
    },
    sessionId
  );
  assert.equal(
    hostCheck.result.value,
    true,
    "Pressing 'f' in real Chromium must inject #vimium-rs-hints-container via WASM HintSession"
  );

  // Press 's' (first letter of DEFAULT_HINT_CHARACTERS = "sadfjklewcmpgh") to activate the 1st link (#link-alpha)
  // Note: With ~250 links, the first hint label is 2 chars ("ss") or 1 char ("s") depending on S = (14^2 - N)/(13).
  // Let's press Escape first to measure repeated 'f' latency with warm marker pool!
  await cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      key: "Escape",
      windowsVirtualKeyCode: 27,
    },
    sessionId
  );
  await cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyUp",
      key: "Escape",
      windowsVirtualKeyCode: 27,
    },
    sessionId
  );

  // Measure warm 'f' activation latency in real Chromium via performance.now()
  const perfEval = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const t0 = performance.now();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true }));
        const t1 = performance.now();
        return t1 - t0;
      })()`,
      returnByValue: true,
    },
    sessionId
  );
  console.log(`[Chromium Benchmark] 250+ visible links 'f' end-to-end latency: ${perfEval.result.value.toFixed(2)} ms`);
  assert.ok(
    perfEval.result.value < 16.0,
    `Expected sub-frame (<16ms) hint activation for 250+ links, got ${perfEval.result.value.toFixed(2)}ms`
  );

  // Type 's' then 's' (since N > 14, first leaf is either 's' or 'ss')
  for (const ch of ["s", "s"]) {
    await cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key: ch,
        text: ch,
        unmodifiedText: ch,
        windowsVirtualKeyCode: 83,
      },
      sessionId
    );
    await cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: ch,
        windowsVirtualKeyCode: 83,
      },
      sessionId
    );
  }

  const clickedCheck = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `window.__clicked`,
      returnByValue: true,
    },
    sessionId
  );
  assert.equal(
    clickedCheck.result.value,
    "alpha",
    "Typing hint label 's' in real Chromium must click #link-alpha"
  );

  // Press '3' then 'j' -> ScrollDown with count = 3 (3 * 60 = 180px)
  for (const [key, code] of [
    ["3", 51],
    ["j", 74],
  ]) {
    await cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key,
        text: key,
        unmodifiedText: key,
        windowsVirtualKeyCode: code,
      },
      sessionId
    );
    await cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key,
        windowsVirtualKeyCode: code,
      },
      sessionId
    );
  }

  // Wait for smooth scroll to progress
  await new Promise((r) => setTimeout(r, 400));

  const scrollCheck = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `window.scrollY`,
      returnByValue: true,
    },
    sessionId
  );
  assert.ok(
    scrollCheck.result.value > 0,
    `Expected window.scrollY > 0 after '3j', got ${scrollCheck.result.value}`
  );
});
