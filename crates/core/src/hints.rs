use crate::geometry::{CandidateElementRecord, HintMarkerLayout};

pub const DEFAULT_HINT_CHARACTERS: &[u8] = b"sadfjklewcmpgh";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HintLabel {
    pub len: u8,
    pub bytes: [u8; 7],
}

impl HintLabel {
    pub fn empty() -> Self {
        Self {
            len: 0,
            bytes: [0; 7],
        }
    }

    pub fn from_slice(slice: &[u8]) -> Self {
        let len = slice.len().min(7) as u8;
        let mut bytes = [0u8; 7];
        bytes[..len as usize].copy_from_slice(&slice[..len as usize]);
        Self { len, bytes }
    }

    pub fn as_str(&self) -> &str {
        core::str::from_utf8(&self.bytes[..self.len as usize]).unwrap_or("")
    }
}

pub struct HintGenerator {
    alphabet: &'static [u8],
}

impl HintGenerator {
    pub fn new(alphabet: &'static [u8]) -> Self {
        Self { alphabet }
    }

    pub fn with_default_alphabet() -> Self {
        Self::new(DEFAULT_HINT_CHARACTERS)
    }

    /// Generates prefix-free hint labels for `count` items.
    ///
    /// Uses optimal M-ary prefix tree derivation:
    /// For alphabet size M and target count N:
    /// Computes depth d such that M^d < N <= M^(d+1).
    /// Short codes are assigned at depth d, and the remaining nodes are expanded to depth d+1.
    pub fn generate_labels(&self, count: usize) -> Vec<HintLabel> {
        let m = self.alphabet.len();
        if count == 0 {
            return Vec::new();
        }

        if count <= m {
            return (0..count)
                .map(|i| HintLabel::from_slice(&[self.alphabet[i]]))
                .collect();
        }

        // Find depth d such that m^d < count <= m^(d+1)
        let mut d = 1usize;
        let mut k = m; // k = m^d
        while k.saturating_mul(m) < count {
            k = k.saturating_mul(m);
            d += 1;
        }

        let next_k = k.saturating_mul(m);
        // S = short leaves at depth d
        // S * (m - 1) = next_k - count
        let s = if next_k >= count {
            (next_k - count) / (m - 1)
        } else {
            0
        };

        let mut labels = Vec::with_capacity(count);
        let mut buf = [0u8; 7];

        // 1. Generate S short labels of depth d
        for i in 0..s {
            let mut val = i;
            for pos in (0..d).rev() {
                buf[pos] = self.alphabet[val % m];
                val /= m;
            }
            labels.push(HintLabel::from_slice(&buf[..d]));
            if labels.len() == count {
                return labels;
            }
        }

        // 2. Generate long labels of depth d + 1 from remaining branches
        let branch_start = s;
        let remaining = count - labels.len();

        for i in 0..remaining {
            let branch_offset = i / m;
            let leaf_digit = i % m;
            let branch_val = branch_start + branch_offset;

            let mut val = branch_val;
            for pos in (0..d).rev() {
                buf[pos] = self.alphabet[val % m];
                val /= m;
            }
            buf[d] = self.alphabet[leaf_digit];
            labels.push(HintLabel::from_slice(&buf[..=d]));
        }

        labels
    }

    /// Generates the disjoint slice `[offset .. offset + count]` from the global prefix-free
    /// tree of size `total_count`. Used for multi-frame hint partitioning across iframes.
    pub fn generate_labels_range(
        &self,
        total_count: usize,
        offset: usize,
        count: usize,
    ) -> Vec<HintLabel> {
        if count == 0 || offset >= total_count {
            return Vec::new();
        }
        let all = self.generate_labels(total_count);
        let end = (offset + count).min(all.len());
        all[offset..end].to_vec()
    }

    /// Computes marker layouts from candidate records by positioning badges and avoiding collisions.
    pub fn compute_layouts(
        &self,
        candidates: &[CandidateElementRecord],
    ) -> Vec<HintMarkerLayout> {
        self.compute_layouts_range(candidates, candidates.len(), 0)
    }

    /// Computes marker layouts using a disjoint range `[offset .. offset + candidates.len()]`
    /// of the global prefix-free tree of size `total_count`.
    pub fn compute_layouts_range(
        &self,
        candidates: &[CandidateElementRecord],
        total_count: usize,
        offset: usize,
    ) -> Vec<HintMarkerLayout> {
        let total = total_count.max(offset + candidates.len());
        let labels = self.generate_labels_range(total, offset, candidates.len());
        let mut layouts: Vec<HintMarkerLayout> = Vec::with_capacity(candidates.len());

        for (i, candidate) in candidates.iter().enumerate() {
            let label = labels.get(i).copied().unwrap_or_else(HintLabel::empty);

            // Upper-left corner of visible element rect with collision offset
            let mut marker_x = candidate.x.max(0.0);
            let marker_y = candidate.y.max(0.0);

            // Check collision with the previous few markers (sliding window W=8)
            let window_start = layouts.len().saturating_sub(8);
            for prev in &layouts[window_start..] {
                let dx = (prev.x - marker_x).abs();
                let dy = (prev.y - marker_y).abs();
                if dx < 14.0 && dy < 12.0 {
                    // Slight rightward cascade offset for overlapping elements
                    marker_x += 14.0;
                }
            }

            layouts.push(HintMarkerLayout {
                element_id: candidate.element_id,
                x: marker_x,
                y: marker_y,
                label_len: label.len,
                label: label.bytes,
                flags: candidate.flags,
            });
        }

        layouts
    }
}

/// Bit 31 in `HintMarkerLayout::flags` indicates the marker is filtered out (hidden).
pub const MARKER_HIDDEN_FLAG: u32 = 1 << 31;

/// Action to execute when a hint label uniquely matches a target element.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum HintAction {
    ClickCurrentTab = 1,
    ClickNewTab = 2,
    CopyLinkUrl = 3,
}

impl HintAction {
    pub fn from_u8(val: u8) -> Self {
        match val {
            2 => HintAction::ClickNewTab,
            3 => HintAction::CopyLinkUrl,
            _ => HintAction::ClickCurrentTab,
        }
    }
}

/// Result of processing a keystroke inside an active `HintSession`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HintStepResult {
    /// A leaf hint matched completely; activate `element_id` with `action`.
    Activate {
        element_id: u32,
        action: HintAction,
    },
    /// Prefix matched a subset of hints; `matched_len` characters are highlighted.
    Filtered {
        active_count: usize,
        matched_len: u8,
    },
    /// Keystroke did not match any remaining hint; session terminates.
    NoMatch,
    /// User pressed Escape; session terminates.
    Cancelled,
}

/// Stateful interactive link hint session operating over generated layouts.
pub struct HintSession {
    layouts: Vec<HintMarkerLayout>,
    action: HintAction,
    typed_buf: [u8; 7],
    typed_len: u8,
    active: bool,
}

impl HintSession {
    pub fn new(candidates: &[CandidateElementRecord], action: HintAction) -> Self {
        Self::new_range(candidates, action, candidates.len(), 0)
    }

    pub fn new_range(
        candidates: &[CandidateElementRecord],
        action: HintAction,
        total_count: usize,
        offset: usize,
    ) -> Self {
        let generator = HintGenerator::with_default_alphabet();
        let layouts = generator.compute_layouts_range(candidates, total_count, offset);
        let active = !layouts.is_empty();
        Self {
            layouts,
            action,
            typed_buf: [0; 7],
            typed_len: 0,
            active,
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn action(&self) -> HintAction {
        self.action
    }

    pub fn typed_prefix(&self) -> &[u8] {
        &self.typed_buf[..self.typed_len as usize]
    }

    pub fn layouts(&self) -> &[HintMarkerLayout] {
        &self.layouts
    }

    pub fn layouts_ptr(&self) -> *const HintMarkerLayout {
        self.layouts.as_ptr()
    }

    pub fn process_key(&mut self, key_byte: u8) -> HintStepResult {
        if !self.active {
            return HintStepResult::Cancelled;
        }

        // Escape cancels immediately
        if key_byte == 27 {
            self.active = false;
            return HintStepResult::Cancelled;
        }

        // Backspace (8 or 127) pops the last typed character
        if key_byte == 8 || key_byte == 127 {
            if self.typed_len > 0 {
                self.typed_len -= 1;
            }
            let active_count = self.update_layout_flags();
            return HintStepResult::Filtered {
                active_count,
                matched_len: self.typed_len,
            };
        }

        // Normalize uppercase ASCII to lowercase for hint matching
        let normalized = key_byte.to_ascii_lowercase();
        if (self.typed_len as usize) < self.typed_buf.len() {
            self.typed_buf[self.typed_len as usize] = normalized;
            self.typed_len += 1;
        }

        let prefix = &self.typed_buf[..self.typed_len as usize];

        // Check for exact leaf match first (because codes are strictly prefix-free,
        // an exact match on any label guarantees no other label has it as a prefix)
        for layout in &self.layouts {
            let label_slice = &layout.label[..layout.label_len as usize];
            if label_slice == prefix {
                self.active = false;
                return HintStepResult::Activate {
                    element_id: layout.element_id,
                    action: self.action,
                };
            }
        }

        let active_count = self.update_layout_flags();
        if active_count == 0 {
            self.active = false;
            HintStepResult::NoMatch
        } else {
            HintStepResult::Filtered {
                active_count,
                matched_len: self.typed_len,
            }
        }
    }

    fn update_layout_flags(&mut self) -> usize {
        let prefix = &self.typed_buf[..self.typed_len as usize];
        let mut active_count = 0;

        for layout in &mut self.layouts {
            let base_flags = layout.flags & 0x00FF_FFFF;
            let label_slice = &layout.label[..layout.label_len as usize];
            if label_slice.starts_with(prefix) {
                layout.flags = base_flags | ((self.typed_len as u32) << 24);
                active_count += 1;
            } else {
                layout.flags = base_flags | MARKER_HIDDEN_FLAG;
            }
        }

        active_count
    }
}
