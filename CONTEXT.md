# Vimium-RS Context

A keyboard-driven browser navigation WebExtension rewritten primarily in Rust and compiled to WebAssembly.

## Language

**Hint Marker**:
A visual letter badge overlaid on interactive or clickable DOM elements for keyboard targeting.
_Avoid_: Link badge, target tag, overlay bubble

**Candidate Record**:
A 32-byte cache-aligned struct (`CandidateElementRecord`) containing element bounding coordinates, integer ID, and bitflags passed directly into WASM linear memory.
_Avoid_: Scanned element, candidate object

**Hint Marker Layout**:
A 24-byte layout struct (`HintMarkerLayout`) produced by the Rust hint engine and read directly by JavaScript to render hint badges into the DOM.
_Avoid_: Marker position, badge dto

**Hint Overlay Container**:
A closed Shadow DOM container (`#vimium-rs-hints-container`) attached to `document.documentElement` isolating hint badge DOM nodes and styles from the webpage.
_Avoid_: Overlay layer, hint div

**Key Sequence**:
An ordered series of keystrokes with optional count prefixes and modifiers mapped to an executable command.
_Avoid_: Key chord, keystroke combo, shortcut

**Key Stroke**:
A packed 16-bit struct (`KeyStroke`) encoding an 8-bit key code and a 4-bit modifier bitmask (Ctrl, Alt, Meta, Shift) for zero-allocation comparisons.
_Avoid_: Key event, key token, raw key

**Exclusion Filter**:
A pre-computed bitset or lookup table compiled from URL pattern rules, allowing $O(1)$ pass-through evaluation per keystroke.
_Avoid_: URL whitelist, ignore list

**Suspended Mode**:
A preserved modal state stored on an internal mode stack when entering transient operational modes like Hints or PassNextKey.
_Avoid_: Background state, previous mode

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
