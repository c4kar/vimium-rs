# Vimium-RS Context

A keyboard-driven browser navigation WebExtension rewritten primarily in Rust and compiled to WebAssembly.

## Language

**Hint Marker**:
A visual letter badge overlaid on interactive or clickable DOM elements for keyboard targeting.
_Avoid_: Link badge, target tag, overlay bubble

**Key Sequence**:
An ordered series of keystrokes with optional count prefixes and modifiers mapped to an executable command.
_Avoid_: Key chord, keystroke combo, shortcut

**Mode**:
A distinct modal state (such as Normal, Insert, Visual, or Find) that dictates how input events are captured and handled.
_Avoid_: Operational state, phase

**Core Engine**:
The pure, platform-agnostic Rust crate (`crates/core`) holding the key parser, prefix tree, hint assignment algorithm, and state machines.
_Avoid_: Business logic, core logic, backend

**Content Engine**:
The in-page WebExtension module (Rust/WASM and JS bindings) responsible for DOM element discovery, event capturing, and rendering hint markers.
_Avoid_: Content script, page agent, frontend

**Background Worker**:
The WebExtension service worker coordinating cross-tab state, window tracking, storage, and privileged browser APIs.
_Avoid_: Background script, daemon, extension manager

**Vomnibar**:
An in-page floating modal interface for interactive fuzzy searching and switching tabs, history, bookmarks, and search engines.
_Avoid_: Omnibar, search popup, quick open

**Exclusion Rule**:
A URL pattern matching condition that disables specific key sequences or passes all keystrokes directly through to the webpage.
_Avoid_: Whitelist, blacklist, ignore pattern
