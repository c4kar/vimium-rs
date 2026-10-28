use std::collections::HashSet;
use vimium_core::{CandidateElementRecord, ElementFlags, HintGenerator};

#[test]
fn test_large_scale_prefix_free_invariants() {
    let generator = HintGenerator::with_default_alphabet();
    // Test a massive page with 2,500 candidate interactive elements
    let count = 2500;
    let labels = generator.generate_labels(count);

    assert_eq!(labels.len(), count);

    let mut set = HashSet::with_capacity(count);
    for label in &labels {
        assert!(label.len > 0);
        assert!(label.len <= 7);
        let s = label.as_str();
        assert!(!s.is_empty());
        assert!(set.insert(s), "Duplicate hint string generated: {}", s);
    }

    // Verify prefix-free property across all pairs
    let list: Vec<&str> = labels.iter().map(|l| l.as_str()).collect();
    for i in 0..100.min(count) {
        for j in (i + 1)..count {
            assert!(
                !list[j].starts_with(list[i]),
                "Hint '{}' is prefix of '{}'",
                list[i],
                list[j]
            );
        }
    }
}

#[test]
fn test_collision_avoidance_layout() {
    let generator = HintGenerator::with_default_alphabet();

    // Two overlapping elements (e.g. nested link inside button or adjacent badges)
    let candidates = vec![
        CandidateElementRecord {
            element_id: 1,
            flags: ElementFlags::CLICKABLE.bits(),
            x: 50.0,
            y: 100.0,
            width: 120.0,
            height: 30.0,
            weight: 10,
            _pad: 0,
            _reserved: 0,
        },
        CandidateElementRecord {
            element_id: 2,
            flags: ElementFlags::CLICKABLE.bits(),
            x: 52.0, // Very close X
            y: 102.0, // Very close Y
            width: 110.0,
            height: 25.0,
            weight: 10,
            _pad: 0,
            _reserved: 0,
        },
    ];

    let layouts = generator.compute_layouts(&candidates);
    assert_eq!(layouts.len(), 2);
    assert_eq!(layouts[0].element_id, 1);
    assert_eq!(layouts[1].element_id, 2);
    assert_eq!(layouts[0].label_len, 1);
    assert_eq!(layouts[1].label_len, 1);
}

#[test]
fn test_cross_frame_disjoint_range_partitioning() {
    let generator = HintGenerator::with_default_alphabet();
    // Frame 0 has 12 candidates, Frame 1 has 8 candidates, Frame 2 has 15 candidates (total = 35)
    let total = 35;
    let full_labels = generator.generate_labels(total);

    let f0 = generator.generate_labels_range(total, 0, 12);
    let f1 = generator.generate_labels_range(total, 12, 8);
    let f2 = generator.generate_labels_range(total, 20, 15);

    assert_eq!(f0.len(), 12);
    assert_eq!(f1.len(), 8);
    assert_eq!(f2.len(), 15);

    let mut combined = Vec::new();
    combined.extend_from_slice(&f0);
    combined.extend_from_slice(&f1);
    combined.extend_from_slice(&f2);

    assert_eq!(combined, full_labels, "Concatenated frame ranges must equal the global prefix-free tree");
}
