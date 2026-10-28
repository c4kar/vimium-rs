import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

function createDomEnvironment() {
  const createdMarkers = [];
  const copiedUrls = [];
  const sentMessages = [];
  const scrolledEvents = [];

  class FakeElement {
    constructor({
      tagName = "A",
      href = "https://example.com/item",
      rects = [{ left: 10, top: 20, right: 90, bottom: 40, width: 80, height: 20 }],
      style = { visibility: "visible", display: "inline", opacity: "1" },
      shadowChildren = null,
    } = {}) {
      this.tagName = tagName;
      this.href = href;
      this._rects = rects;
      this._style = style;
      this.dataset = {};
      this.style = {};
      this.children = [];
      this.dispatchedEvents = [];
      this.focused = false;
      this.isContentEditable = false;
      this.shadowRoot = shadowChildren
        ? {
            querySelectorAll: () => shadowChildren,
          }
        : null;
    }

    getClientRects() {
      return this._rects;
    }

    getBoundingClientRect() {
      return (
        this._rects[0] || {
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
        }
      );
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    remove() {
      this._removed = true;
    }

    focus() {
      this.focused = true;
    }

    dispatchEvent(ev) {
      this.dispatchedEvents.push(ev.type);
      return true;
    }

    attachShadow({ mode }) {
      const root = {
        mode,
        children: [],
        appendChild(node) {
          if (node.isFragment) {
            for (const c of node.children) {
              this.children.push(c);
            }
          } else {
            this.children.push(node);
          }
        },
        querySelectorAll(sel) {
          if (sel === ".vimium-hint-marker") {
            return this.children.filter(
              (c) => c.className === "vimium-hint-marker" && !c._removed
            );
          }
          return [];
        },
      };
      this._closedShadow = root;
      return root;
    }
  }

  const topElements = [];
  const keydownListeners = [];

  const context = {
    console,
    TextDecoder,
    Uint8Array,
    Uint32Array,
    Float32Array,
    WebAssembly,
    setTimeout,
    clearTimeout,
    performance: { now: () => 0 },
    MouseEvent: class MouseEvent {
      constructor(type, opts) {
        this.type = type;
        this.opts = opts;
      }
    },
    navigator: {
      clipboard: {
        writeText: async (text) => {
          copiedUrls.push(text);
        },
      },
    },
    chrome: {
      runtime: {
        getURL: (p) => p,
        sendMessage: async (msg) => {
          sentMessages.push(msg);
        },
        onMessage: {
          addListener: () => {},
        },
      },
    },
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      scrollBy: (opts) => scrolledEvents.push(opts),
      getComputedStyle: (el) =>
        el._style || { visibility: "visible", display: "block", opacity: "1" },
      addEventListener: (type, fn) => {
        if (type === "keydown") keydownListeners.push(fn);
      },
    },
    document: {
      activeElement: null,
      documentElement: new FakeElement({ tagName: "HTML" }),
      querySelectorAll: () => topElements,
      elementFromPoint: () => null,
      createElement: (tag) => {
        const el = new FakeElement({ tagName: tag.toUpperCase() });
        createdMarkers.push(el);
        return el;
      },
      createDocumentFragment: () => ({
        isFragment: true,
        children: [],
        appendChild(child) {
          this.children.push(child);
        },
      }),
    },
    fetch: async () => {
      throw new Error("Should use instantiate fallback or mock fetch");
    },
  };
  context.window.window = context.window;
  context.window.document = context.document;

  return {
    FakeElement,
    topElements,
    keydownListeners,
    createdMarkers,
    copiedUrls,
    sentMessages,
    scrolledEvents,
    context,
  };
}

test("Content loader collects multi-line rects, pierces open Shadow DOM, filters hints, and activates element", async () => {
  const env = createDomEnvironment();

  // 1. Multi-line inline link (first rect offscreen, second rect visible)
  const multiLineLink = new env.FakeElement({
    tagName: "A",
    href: "https://example.com/multiline",
    rects: [
      { left: -200, top: -50, right: -10, bottom: -30, width: 190, height: 20 },
      { left: 45, top: 120, right: 185, bottom: 140, width: 140, height: 20 },
    ],
  });

  // 2. Hidden link via computed style
  const hiddenLink = new env.FakeElement({
    tagName: "A",
    href: "https://example.com/hidden",
    rects: [{ left: 50, top: 50, right: 120, bottom: 70, width: 70, height: 20 }],
    style: { visibility: "hidden", display: "block", opacity: "1" },
  });

  // 3. Button inside an open ShadowRoot
  const shadowButton = new env.FakeElement({
    tagName: "BUTTON",
    rects: [{ left: 200, top: 300, right: 280, bottom: 330, width: 80, height: 30 }],
  });
  const hostWithOpenShadow = new env.FakeElement({
    tagName: "DIV",
    rects: [{ left: 190, top: 290, right: 300, bottom: 350, width: 110, height: 60 }],
    shadowChildren: [shadowButton],
  });

  env.topElements.push(multiLineLink, hiddenLink, hostWithOpenShadow);

  const wasmPath = path.resolve("extension/dist/vimium_content_bg.wasm");
  const wasmBytes = fs.readFileSync(wasmPath);

  env.context.WebAssembly = {
    instantiateStreaming: async () => WebAssembly.instantiate(wasmBytes, {}),
    instantiate: async (bytes, imports) => WebAssembly.instantiate(bytes, imports),
  };
  env.context.fetch = async () => ({
    arrayBuffer: async () => wasmBytes,
  });

  const loaderCode = fs.readFileSync(
    path.resolve("extension/content/loader.js"),
    "utf8"
  );
  vm.createContext(env.context);
  vm.runInContext(loaderCode, env.context);

  // Wait for async initWasm()
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(env.keydownListeners.length, 1, "Keydown listener registered");
  const onKeyDown = env.keydownListeners[0];

  // Press 'f' to trigger LinkHints in current tab
  let prevented = false;
  onKeyDown({
    key: "f",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true, "'f' keystroke should be intercepted");

  // Verify closed shadow root has exactly 2 visible markers (multiLineLink + shadowButton; hiddenLink excluded)
  const host = env.context.document.documentElement.children[0];
  assert.ok(host, "Shadow host attached to documentElement");
  const activeMarkers = host._closedShadow.querySelectorAll(".vimium-hint-marker");
  assert.equal(
    activeMarkers.length,
    2,
    "Should render 2 hints (multi-line visible rect + open shadow button)"
  );

  // Multi-line link should use its 2nd rect (left=45, top=120)
  assert.equal(activeMarkers[0].style.left, "45px");
  assert.equal(activeMarkers[0].style.top, "120px");

  // Type first hint's label to activate multiLineLink
  const firstLabel = activeMarkers[0].dataset.label || activeMarkers[0].textContent.toLowerCase();
  for (const ch of firstLabel) {
    onKeyDown({
      key: ch,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: () => {},
    });
  }

  assert.deepEqual(
    multiLineLink.dispatchedEvents,
    ["mouseover", "mousedown", "mouseup", "click"],
    "Target element should receive full mouse event cascade"
  );
});

test("Content loader handles multi-char hint prefix highlighting, Backspace un-filtering, and yf CopyLinkUrl", async () => {
  const env = createDomEnvironment();

  // Create 20 visible links so prefix-free tree generates 2-char hints
  for (let i = 0; i < 20; i++) {
    env.topElements.push(
      new env.FakeElement({
        tagName: "A",
        href: `https://example.com/link-${i}`,
        rects: [
          {
            left: 10 + (i % 5) * 100,
            top: 20 + Math.floor(i / 5) * 40,
            right: 90 + (i % 5) * 100,
            bottom: 40 + Math.floor(i / 5) * 40,
            width: 80,
            height: 20,
          },
        ],
      })
    );
  }

  const wasmPath = path.resolve("extension/dist/vimium_content_bg.wasm");
  const wasmBytes = fs.readFileSync(wasmPath);

  env.context.WebAssembly = {
    instantiateStreaming: async () => WebAssembly.instantiate(wasmBytes, {}),
    instantiate: async (bytes, imports) => WebAssembly.instantiate(bytes, imports),
  };
  env.context.fetch = async () => ({
    arrayBuffer: async () => wasmBytes,
  });

  const loaderCode = fs.readFileSync(
    path.resolve("extension/content/loader.js"),
    "utf8"
  );
  vm.createContext(env.context);
  vm.runInContext(loaderCode, env.context);

  await new Promise((r) => setTimeout(r, 20));
  const onKeyDown = env.keydownListeners[0];

  // Trigger 'y' then 'f' -> CopyLinkUrl hint session
  onKeyDown({
    key: "y",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => {},
  });
  onKeyDown({
    key: "f",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => {},
  });

  const host = env.context.document.documentElement.children[0];
  const markers = host._closedShadow.querySelectorAll(".vimium-hint-marker");
  assert.equal(markers.length, 20, "All 20 markers rendered");

  const twoCharMarker = markers.find((m) => m.dataset.label.length === 2);
  assert.ok(twoCharMarker, "Should have a 2-character hint marker");
  const label = twoCharMarker.dataset.label;
  const targetIndex = Number(twoCharMarker.dataset.elementId);

  // Type 1st character -> should highlight prefix and hide non-matching markers
  onKeyDown({
    key: label[0],
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => {},
  });

  assert.equal(
    twoCharMarker.innerHTML,
    `<span class="vimium-hint-matched">${label[0]}</span>${label[1]}`,
    "Matched prefix character wrapped in .vimium-hint-matched"
  );

  // Press Backspace -> should un-filter all 20 markers
  onKeyDown({
    key: "Backspace",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => {},
  });

  const visibleCountAfterBackspace = markers.filter(
    (m) => m.style.display !== "none"
  ).length;
  assert.equal(visibleCountAfterBackspace, 20, "Backspace restores all 20 hints");

  // Complete the 2-char label -> should copy link URL to clipboard
  onKeyDown({
    key: label[0],
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => {},
  });
  onKeyDown({
    key: label[1],
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => {},
  });

  assert.deepEqual(env.copiedUrls, [`https://example.com/link-${targetIndex}`]);
});
