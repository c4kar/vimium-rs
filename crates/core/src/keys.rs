use crate::mode::Mode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    ScrollDown,
    ScrollUp,
    ScrollPageDown,
    ScrollPageUp,
    ScrollToTop,
    ScrollToBottom,
    LinkHints,
    LinkHintsNewTab,
    Vomnibar,
    EnterInsertMode,
    EnterVisualMode,
    EnterFindMode,
    ExitMode,
    PassNextKey,
    Custom(u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchResult {
    /// Action matched with optional count multiplier (e.g. `10j` -> count=10)
    Execute { action: KeyAction, count: u32 },
    /// Partial match; waiting for next keystroke
    Pending,
    /// No matching sequence; key should pass through to the page
    PassThrough,
    /// Cleared/Cancelled (e.g. on Esc)
    Cancelled,
}

#[derive(Default)]
struct TrieNode {
    key: u8,
    action: Option<KeyAction>,
    first_child: u16,
    next_sibling: u16,
}

pub struct KeyTrie {
    nodes: Vec<TrieNode>,
}

impl Default for KeyTrie {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyTrie {
    pub fn new() -> Self {
        let mut trie = Self {
            nodes: Vec::with_capacity(64),
        };
        // Root node at index 0
        trie.nodes.push(TrieNode::default());
        trie
    }

    pub fn insert(&mut self, sequence: &[u8], action: KeyAction) {
        if sequence.is_empty() {
            return;
        }

        let mut curr_idx = 0usize;

        for &key in sequence {
            let child_idx = self.find_child(curr_idx, key);
            if let Some(idx) = child_idx {
                curr_idx = idx;
            } else {
                let new_idx = self.nodes.len();
                let old_first = self.nodes[curr_idx].first_child;

                self.nodes.push(TrieNode {
                    key,
                    action: None,
                    first_child: 0,
                    next_sibling: old_first,
                });

                self.nodes[curr_idx].first_child = new_idx as u16;
                curr_idx = new_idx;
            }
        }

        self.nodes[curr_idx].action = Some(action);
    }

    fn find_child(&self, parent_idx: usize, key: u8) -> Option<usize> {
        let mut child = self.nodes[parent_idx].first_child as usize;
        while child != 0 {
            if self.nodes[child].key == key {
                return Some(child);
            }
            child = self.nodes[child].next_sibling as usize;
        }
        None
    }
}

pub struct KeySequenceEngine {
    trie: KeyTrie,
    mode: Mode,
    cursor: usize,
    count: u32,
    has_count: bool,
}

impl KeySequenceEngine {
    pub fn new(trie: KeyTrie) -> Self {
        Self {
            trie,
            mode: Mode::Normal,
            cursor: 0,
            count: 0,
            has_count: false,
        }
    }

    pub fn with_default_bindings() -> Self {
        let mut trie = KeyTrie::new();
        // Navigation
        trie.insert(b"j", KeyAction::ScrollDown);
        trie.insert(b"k", KeyAction::ScrollUp);
        trie.insert(b"d", KeyAction::ScrollPageDown);
        trie.insert(b"u", KeyAction::ScrollPageUp);
        trie.insert(b"gg", KeyAction::ScrollToTop);
        trie.insert(b"G", KeyAction::ScrollToBottom);

        // Hints
        trie.insert(b"f", KeyAction::LinkHints);
        trie.insert(b"F", KeyAction::LinkHintsNewTab);

        // Omnibar & Modes
        trie.insert(b"o", KeyAction::Vomnibar);
        trie.insert(b"i", KeyAction::EnterInsertMode);
        trie.insert(b"v", KeyAction::EnterVisualMode);
        trie.insert(b"/", KeyAction::EnterFindMode);

        Self::new(trie)
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
        self.reset_state();
    }

    pub fn reset_state(&mut self) {
        self.cursor = 0;
        self.count = 0;
        self.has_count = false;
    }

    pub fn process_key(&mut self, key: u8) -> DispatchResult {
        // Esc always resets and exits back to Normal
        if key == 27 { // ASCII Esc
            self.mode = Mode::Normal;
            self.reset_state();
            return DispatchResult::Cancelled;
        }

        // If in Insert mode, pass everything through except Esc
        if self.mode == Mode::Insert {
            return DispatchResult::PassThrough;
        }

        // Handle numeric count prefix in Normal mode (when not in middle of a multi-key sequence)
        if self.cursor == 0 && (b'0'..=b'9').contains(&key) {
            let digit = (key - b'0') as u32;
            if self.has_count || digit > 0 {
                self.count = self.count.saturating_mul(10).saturating_add(digit);
                self.has_count = true;
                return DispatchResult::Pending;
            }
        }

        // Match against Trie
        let next_node = self.trie.find_child(self.cursor, key);
        match next_node {
            Some(idx) => {
                if let Some(action) = self.trie.nodes[idx].action {
                    let total_count = if self.has_count { self.count.max(1) } else { 1 };
                    self.reset_state();
                    DispatchResult::Execute {
                        action,
                        count: total_count,
                    }
                } else {
                    // Intermediate prefix matched (e.g. first 'g' in 'gg')
                    self.cursor = idx;
                    DispatchResult::Pending
                }
            }
            None => {
                // Key did not match any sequence
                self.reset_state();
                DispatchResult::PassThrough
            }
        }
    }
}
