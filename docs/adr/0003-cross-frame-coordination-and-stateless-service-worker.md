# 0003: Cross-Frame Coordination and Stateless Service Worker IPC

We chose a hierarchical two-phase handshake for multi-frame link hints, one-off typed message envelopes for content-to-background IPC, and a stateless WASM architecture for the Manifest V3 Background Worker backed by `chrome.storage.session`. Global events (such as hint dismissal) broadcast tab-wide via `chrome.tabs.sendMessage` without `frameId`.

## Context

Modern web pages contain complex iframe hierarchies, including cross-origin iframes (payment widgets, video players, sandboxed third-party apps) whose DOM cannot be inspected or modified by parent frames. Simultaneously, Chrome Manifest V3 service workers terminate after ~30 seconds of inactivity, clearing all WASM linear memory and in-memory variables.

## Considered Options

- **Long-Lived `chrome.runtime.Port` Connections**: Rejected due to frequent disconnected port errors and complex reconnection loops caused by MV3 background worker idle terminations.
- **Service Worker Keep-Alive Hacks (Periodic Alarms/Ports)**: Rejected as hostile to battery/CPU efficiency and vulnerable to rejection under Chrome Web Store policies.
- **Top-Frame Direct Iframe Traversal**: Rejected because browser cross-origin security prevents parent frames from querying or styling cross-origin iframe DOM trees.
- **Stateless WASM Worker + Hierarchical Two-Phase Handshake**: Accepted. Content frames scan local elements and report counts; the background/top frame allocates non-overlapping prefix partitions of the hint tree; each frame renders locally in its closed Shadow DOM. All persistent state is rehydrated from `chrome.storage.session`.
