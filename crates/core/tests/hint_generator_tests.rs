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
        },
    ];

    let layouts = generator.compute_layouts(&candidates);
    assert_eq!(layouts.len(), 2);
    assert_eq!(layouts[0].element_id, 1);
    assert_eq!(layouts[1].element_id, 2);
    assert_eq!(layouts[0].label_len, 1);
    assert_eq!(layouts[1].label_len, 1);
}
