use crate::mode::Mode;

bitflags::bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
    pub struct KeyModifiers: u8 {
        const CTRL  = 1 << 0;
        const ALT   = 1 << 1;
        const META  = 1 << 2;
        const SHIFT = 1 << 3;
    }
}

/// Packed 16-bit representation of a key event: 8-bit key code + 4-bit modifier mask.
#[repr(transparent)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct KeyStroke(pub u16);

impl KeyStroke {
    pub const fn new(key: u8, modifiers: KeyModifiers) -> Self {
        Self(((modifiers.bits() as u16) << 8) | (key as u16))
    }

    pub const fn from_ascii(key: u8) -> Self {
        Self(key as u16)
    }

    pub const fn key(&self) -> u8 {
        (self.0 & 0xFF) as u8
    }

    pub fn modifiers(&self) -> KeyModifiers {
        KeyModifiers::from_bits_truncate(((self.0 >> 8) & 0xFF) as u8)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    ScrollDown,
    ScrollUp,
    ScrollLeft,
    ScrollRight,
    ScrollPageDown,
    ScrollPageUp,
    ScrollToTop,
    ScrollToBottom,
    ScrollHalfPageLeft,
    ScrollHalfPageRight,
    HistoryBack,
    HistoryForward,
    ReloadTab,
    ReloadTabHard,
    GoUpUrl,
    GoToRootUrl,
    CreateTab,
    PreviousTab,
    NextTab,
    CloseTab,
    RestoreTab,
    DuplicateTab,
    MoveTabLeft,
    MoveTabRight,
    LinkHints,
    LinkHintsNewTab,
    CopyCurrentUrl,
    CopyLinkUrl,
    OpenFromClipboard,
    OpenFromClipboardNewTab,
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
    /// Partial match; waiting for next keystroke in multi-key sequence
    Pending,
    /// Key matches configured exclusion or is not intercepted; pass through to the page
    PassThrough,
    /// Cleared/Cancelled (e.g. on Esc)
    Cancelled,
}

#[derive(Default, Clone, Copy)]
struct TrieNode {
    key: KeyStroke,
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

    pub fn insert(&mut self, sequence: &[KeyStroke], action: KeyAction) {
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

    pub fn insert_ascii(&mut self, sequence: &[u8], action: KeyAction) {
        let strokes: Vec<KeyStroke> = sequence.iter().map(|&k| KeyStroke::from_ascii(k)).collect();
        self.insert(&strokes, action);
    }

    fn find_child(&self, parent_idx: usize, key: KeyStroke) -> Option<usize> {
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

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ExclusionRule {
    pub pattern: String,
    pub pass_keys: String,
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let p_bytes = pattern.as_bytes();
    let t_bytes = text.as_bytes();
    let mut p_idx = 0;
    let mut t_idx = 0;
    let mut star_p = None;
    let mut star_t = 0;

    while t_idx < t_bytes.len() {
        if p_idx < p_bytes.len() && (p_bytes[p_idx] == b'?' || p_bytes[p_idx] == t_bytes[t_idx]) {
            p_idx += 1;
            t_idx += 1;
        } else if p_idx < p_bytes.len() && p_bytes[p_idx] == b'*' {
            star_p = Some(p_idx);
            p_idx += 1;
            star_t = t_idx;
        } else if let Some(sp) = star_p {
            p_idx = sp + 1;
            star_t += 1;
            t_idx = star_t;
        } else {
            return false;
        }
    }

    while p_idx < p_bytes.len() && p_bytes[p_idx] == b'*' {
        p_idx += 1;
    }

    p_idx == p_bytes.len()
}

/// Pre-computed bitset filter for O(1) pass-through key evaluation.
#[derive(Debug, Clone, Default)]
pub struct ExclusionFilter {
    /// 256-bit set for plain ASCII keys
    pass_ascii: [u64; 4],
    disabled_entirely: bool,
}

impl ExclusionFilter {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn disabled() -> Self {
        Self {
            pass_ascii: [0; 4],
            disabled_entirely: true,
        }
    }

    pub fn for_url(rules: &[ExclusionRule], url: &str) -> Self {
        for rule in rules {
            if glob_match(&rule.pattern, url) {
                if rule.pass_keys.is_empty() {
                    return Self::disabled();
                } else {
                    let mut filter = Self::none();
                    for b in rule.pass_keys.bytes() {
                        filter.add_pass_key(b);
                    }
                    return filter;
                }
            }
        }
        Self::none()
    }

    pub fn add_pass_key(&mut self, key: u8) {
        let idx = (key / 64) as usize;
        let bit = key % 64;
        self.pass_ascii[idx] |= 1u64 << bit;
    }

    pub fn is_passed(&self, stroke: KeyStroke) -> bool {
        if self.disabled_entirely {
            return true;
        }
        // Only plain keys without modifiers are matched by standard passKeys
        if stroke.modifiers().is_empty() {
            let key = stroke.key();
            let idx = (key / 64) as usize;
            let bit = key % 64;
            (self.pass_ascii[idx] & (1u64 << bit)) != 0
        } else {
            false
        }
    }
}

pub struct KeySequenceEngine {
    trie: KeyTrie,
    mode: Mode,
    suspended_mode: Option<Mode>,
    exclusion: ExclusionFilter,
    cursor: usize,
    count: u32,
    has_count: bool,
}

impl KeySequenceEngine {
    pub fn new(trie: KeyTrie) -> Self {
        Self {
            trie,
            mode: Mode::Normal,
            suspended_mode: None,
            exclusion: ExclusionFilter::none(),
            cursor: 0,
            count: 0,
            has_count: false,
        }
    }

    pub fn with_default_bindings() -> Self {
        let mut trie = KeyTrie::new();
        // Navigation motions
        trie.insert_ascii(b"j", KeyAction::ScrollDown);
        trie.insert_ascii(b"k", KeyAction::ScrollUp);
        trie.insert_ascii(b"h", KeyAction::ScrollLeft);
        trie.insert_ascii(b"l", KeyAction::ScrollRight);
        trie.insert_ascii(b"0", KeyAction::ScrollLeft);
        trie.insert_ascii(b"$", KeyAction::ScrollRight);
        trie.insert_ascii(b"d", KeyAction::ScrollPageDown);
        trie.insert_ascii(b"u", KeyAction::ScrollPageUp);
        trie.insert_ascii(b"gg", KeyAction::ScrollToTop);
        trie.insert_ascii(b"G", KeyAction::ScrollToBottom);
        trie.insert_ascii(b"zH", KeyAction::ScrollHalfPageLeft);
        trie.insert_ascii(b"zL", KeyAction::ScrollHalfPageRight);

        // Modifiers: Ctrl-d, Ctrl-u, Ctrl-e, Ctrl-y
        trie.insert(&[KeyStroke::new(b'd', KeyModifiers::CTRL)], KeyAction::ScrollPageDown);
        trie.insert(&[KeyStroke::new(b'u', KeyModifiers::CTRL)], KeyAction::ScrollPageUp);
        trie.insert(&[KeyStroke::new(b'e', KeyModifiers::CTRL)], KeyAction::ScrollDown);
        trie.insert(&[KeyStroke::new(b'y', KeyModifiers::CTRL)], KeyAction::ScrollUp);

        // History
        trie.insert_ascii(b"H", KeyAction::HistoryBack);
        trie.insert_ascii(b"L", KeyAction::HistoryForward);
        trie.insert_ascii(b"r", KeyAction::ReloadTab);
        trie.insert_ascii(b"R", KeyAction::ReloadTabHard);
        trie.insert_ascii(b"gu", KeyAction::GoUpUrl);
        trie.insert_ascii(b"gU", KeyAction::GoToRootUrl);

        // Tabs
        trie.insert_ascii(b"t", KeyAction::CreateTab);
        trie.insert_ascii(b"J", KeyAction::PreviousTab);
        trie.insert_ascii(b"gT", KeyAction::PreviousTab);
        trie.insert_ascii(b"K", KeyAction::NextTab);
        trie.insert_ascii(b"gt", KeyAction::NextTab);
        trie.insert_ascii(b"x", KeyAction::CloseTab);
        trie.insert_ascii(b"X", KeyAction::RestoreTab);
        trie.insert_ascii(b"yt", KeyAction::DuplicateTab);
        trie.insert_ascii(b"<<", KeyAction::MoveTabLeft);
        trie.insert_ascii(b">>", KeyAction::MoveTabRight);

        // Hints
        trie.insert_ascii(b"f", KeyAction::LinkHints);
        trie.insert_ascii(b"F", KeyAction::LinkHintsNewTab);

        // Clipboard & URL
        trie.insert_ascii(b"yy", KeyAction::CopyCurrentUrl);
        trie.insert_ascii(b"yf", KeyAction::CopyLinkUrl);
        trie.insert_ascii(b"p", KeyAction::OpenFromClipboard);
        trie.insert_ascii(b"P", KeyAction::OpenFromClipboardNewTab);

        // Omnibar & Modes
        trie.insert_ascii(b"o", KeyAction::Vomnibar);
        trie.insert_ascii(b"i", KeyAction::EnterInsertMode);
        trie.insert_ascii(b"v", KeyAction::EnterVisualMode);
        trie.insert_ascii(b"/", KeyAction::EnterFindMode);

        Self::new(trie)
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
        self.suspended_mode = None;
        self.reset_state();
    }

    pub fn enter_transient_mode(&mut self, transient: Mode) {
        self.suspended_mode = Some(self.mode);
        self.mode = transient;
        self.reset_state();
    }

    pub fn exit_transient_mode(&mut self) {
        self.mode = self.suspended_mode.take().unwrap_or(Mode::Normal);
        self.reset_state();
    }

    pub fn set_exclusion_filter(&mut self, filter: ExclusionFilter) {
        self.exclusion = filter;
    }

    pub fn reset_state(&mut self) {
        self.cursor = 0;
        self.count = 0;
        self.has_count = false;
    }

    pub fn process_stroke(&mut self, stroke: KeyStroke) -> DispatchResult {
        let key = stroke.key();

        // Esc always clears state and returns to Normal (or resumes suspended mode)
        if key == 27 {
            self.exit_transient_mode();
            return DispatchResult::Cancelled;
        }

        // PassNextKey mode: pass one key through, then resume previous mode
        if self.mode == Mode::PassNextKey {
            self.exit_transient_mode();
            return DispatchResult::PassThrough;
        }

        // Insert mode passes everything through
        if self.mode == Mode::Insert {
            return DispatchResult::PassThrough;
        }

        // Exclusion check: if key is in passKeys, pass through immediately
        if self.exclusion.is_passed(stroke) {
            return DispatchResult::PassThrough;
        }

        // Strict Vim count prefix handling in Normal mode:
        // '0' with NO accumulator dispatches as a command (e.g. ScrollLeft).
        // '1'..'9' starts an accumulator; subsequent '0'..'9' multiplies count.
        if self.cursor == 0 && stroke.modifiers().is_empty() {
            if self.has_count && (b'0'..=b'9').contains(&key) {
                let digit = (key - b'0') as u32;
                self.count = self.count.saturating_mul(10).saturating_add(digit);
                return DispatchResult::Pending;
            } else if !self.has_count && (b'1'..=b'9').contains(&key) {
                self.count = (key - b'0') as u32;
                self.has_count = true;
                return DispatchResult::Pending;
            }
        }

        // Match against Trie
        let next_node = self.trie.find_child(self.cursor, stroke);
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

    pub fn process_key(&mut self, ascii_key: u8) -> DispatchResult {
        self.process_stroke(KeyStroke::from_ascii(ascii_key))
    }
}
