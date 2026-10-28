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

    /// Computes marker layouts from candidate records by positioning badges and avoiding collisions.
    pub fn compute_layouts(
        &self,
        candidates: &[CandidateElementRecord],
    ) -> Vec<HintMarkerLayout> {
        let labels = self.generate_labels(candidates.len());
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
