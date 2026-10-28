use vimium_background::{compute_frame_allocations, FramePrefixAllocation};

#[test]
fn test_background_frame_prefix_allocations() {
    // 3 frames: frame 0 has 10 candidates, frame 101 has 0 candidates, frame 102 has 15 candidates
    let frames = vec![(0u32, 10u32), (101u32, 0u32), (102u32, 15u32)];
    let (total, allocations) = compute_frame_allocations(&frames);

    assert_eq!(total, 25);
    assert_eq!(
        allocations,
        vec![
            FramePrefixAllocation {
                frame_id: 0,
                start_index: 0,
                count: 10,
            },
            FramePrefixAllocation {
                frame_id: 101,
                start_index: 10,
                count: 0,
            },
            FramePrefixAllocation {
                frame_id: 102,
                start_index: 10,
                count: 15,
            },
        ]
    );
}
