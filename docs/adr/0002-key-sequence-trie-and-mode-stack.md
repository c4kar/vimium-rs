# 0002: Key Sequence Trie and Modal State Stack

We chose a packed 16-bit `KeyStroke` representation, a flat arena-backed `KeyTrie`, and a modal state machine with a suspended mode stack in `crates/core`. Count prefixes follow strict Vim semantics (`0` dispatches `scrollToLeft` if first, but multiplies if preceded by `1..9`), and URL exclusion rules are compiled into a pre-computed bitset for $O(1)$ pass-through checks.

## Context

Keystroke interception in browser extensions occurs on the hot path of every user keypress. Converting browser `KeyboardEvent` objects into heap-allocated strings (e.g. `"<c-j>"`) or evaluating regex expressions on every keydown introduces measurable latency and garbage collection pressure. Furthermore, temporary modes like `Hints` or `PassNextKey` must return cleanly to the previous operational mode (e.g. `Visual` or `Normal`) without blindly resetting to `Normal`.

## Considered Options

- **String-based Tokens & Map Lookups**: Rejected due to string transcoding and allocation overhead on every keystroke.
- **Timestamped Asynchronous Trie in WASM**: Rejected because managing timers inside WASM complicates testing and introduces platform clock dependencies. JS handles the pending timeout cleanly via standard `setTimeout`.
- **Flat Arena KeyTrie with Packed KeyStroke and Mode Stack**: Accepted. All key operations execute with zero heap allocation, $O(1)$ modifier checks, strict Vim semantics, and clean modal suspension.
