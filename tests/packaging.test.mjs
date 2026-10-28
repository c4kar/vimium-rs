import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("Manifest V3 configuration and compiled WASM bundles satisfy Chrome and Firefox requirements", () => {
  const manifestPath = path.resolve("extension/manifest.json");
  assert.ok(fs.existsSync(manifestPath), "extension/manifest.json must exist");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(
    manifest.content_security_policy?.extension_pages?.includes("wasm-unsafe-eval"),
    "MV3 CSP must include 'wasm-unsafe-eval'"
  );
  assert.ok(
    manifest.browser_specific_settings?.gecko?.id,
    "Firefox MV3 requires browser_specific_settings.gecko.id"
  );
  assert.ok(
    manifest.background?.service_worker && manifest.background?.scripts,
    "Background must support both Chrome service_worker and Firefox scripts"
  );

  // Verify compiled WASM artifacts exist and have zero unresolved imports
  const contentWasmPath = path.resolve("extension/dist/vimium_content_bg.wasm");
  const bgWasmPath = path.resolve("extension/dist/vimium_background_bg.wasm");
  assert.ok(fs.existsSync(contentWasmPath), "vimium_content_bg.wasm must be built");
  assert.ok(fs.existsSync(bgWasmPath), "vimium_background_bg.wasm must be built");

  const contentMod = new WebAssembly.Module(fs.readFileSync(contentWasmPath));
  const bgMod = new WebAssembly.Module(fs.readFileSync(bgWasmPath));
  assert.equal(
    WebAssembly.Module.imports(contentMod).length,
    0,
    "vimium_content_bg.wasm must have zero external JS glue imports"
  );
  assert.equal(
    WebAssembly.Module.imports(bgMod).length,
    0,
    "vimium_background_bg.wasm must have zero external JS glue imports"
  );

  // Verify packaged release archives exist
  const chromeZip = path.resolve("dist/vimium-rs-chrome-mv3.zip");
  const firefoxXpi = path.resolve("dist/vimium-rs-firefox-mv3.xpi");
  assert.ok(fs.existsSync(chromeZip), "dist/vimium-rs-chrome-mv3.zip must be packaged");
  assert.ok(fs.existsSync(firefoxXpi), "dist/vimium-rs-firefox-mv3.xpi must be packaged");
});
