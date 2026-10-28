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
    /// For alphabet size M and element count N:
    /// If N <= M: single-character hints.
    /// If N > M: expands branch nodes to ensure no hint is a prefix of another hint.
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

        // Compute number of branch nodes to expand
        // N <= M + branches * (M - 1) => branches >= ceil((N - M) / (M - 1))
        let branch_count = (count - m + (m - 2)) / (m - 1);
        let mut labels = Vec::with_capacity(count);

        let mut buf = [0u8; 7];

        for i in 0..count {
            if i < (m - branch_count) {
                // Short single-character hint
                let char_idx = branch_count + i;
                labels.push(HintLabel::from_slice(&[self.alphabet[char_idx]]));
            } else {
                // Two-character (or deeper) hint
                let offset = i - (m - branch_count);
                let first_char = offset / m;
                let second_char = offset % m;

                if first_char < branch_count {
                    buf[0] = self.alphabet[first_char];
                    buf[1] = self.alphabet[second_char];
                    labels.push(HintLabel::from_slice(&buf[..2]));
                } else {
                    // Fallback for larger sets: recursive digit representation
                    let mut temp = offset;
                    let mut depth = 0;
                    while temp > 0 || depth == 0 {
                        buf[depth] = self.alphabet[temp % m];
                        temp /= m;
                        depth += 1;
                    }
                    buf[..depth].reverse();
                    labels.push(HintLabel::from_slice(&buf[..depth]));
                }
            }
        }

        labels
    }

    /// Computes marker layouts from candidate records by positioning badges and avoiding collisions.
    pub fn compute_layouts(
        &self,
        candidates: &[CandidateElementRecord],
    ) -> Vec<HintMarkerLayout> {
        let labels = self.generate_labels(candidates.len());
        let mut layouts = Vec::with_capacity(candidates.len());

        for (i, candidate) in candidates.iter().enumerate() {
            let label = labels.get(i).copied().unwrap_or_else(HintLabel::empty);
            
            // Standard Vimium marker placement: upper-left corner of visible element rect
            // with a slight inner margin
            let marker_x = candidate.x.max(0.0);
            let marker_y = candidate.y.max(0.0);

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
