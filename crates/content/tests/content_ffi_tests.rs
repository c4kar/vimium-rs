use std::sync::Mutex;
use vimium_content::{
    allocate_candidates_buffer, get_layouts_count, init_content_engine, process_stroke_event,
    reset_key_state, start_hint_session, step_hint_session,
};
use vimium_core::{CandidateElementRecord, ElementFlags, KeyModifiers};

static TEST_LOCK: Mutex<()> = Mutex::new(());

fn make_candidates(count: usize) -> Vec<CandidateElementRecord> {
    (0..count)
        .map(|i| CandidateElementRecord {
            element_id: (i + 500) as u32,
            flags: ElementFlags::CLICKABLE.bits(),
            x: (i as f32) * 30.0,
            y: 20.0,
            width: 28.0,
            height: 18.0,
            weight: 10,
            _pad: 0,
            _reserved: 0,
        })
        .collect()
}

#[test]
fn test_reusable_candidates_buffer_no_leak() {
    let _guard = TEST_LOCK.lock().unwrap();
    init_content_engine();

    let ptr1 = allocate_candidates_buffer(100);
    assert!(!ptr1.is_null());

    // Requesting <= capacity should reuse the exact same allocation pointer
    let ptr2 = allocate_candidates_buffer(50);
    assert_eq!(ptr1, ptr2, "Candidate buffer must be reused across calls");

    let ptr3 = allocate_candidates_buffer(100);
    assert_eq!(ptr1, ptr3, "Candidate buffer must be reused at same capacity");
}

#[test]
fn test_process_stroke_event_and_reset_timeout() {
    let _guard = TEST_LOCK.lock().unwrap();
    init_content_engine();

    // Start a multi-key sequence: 'g' -> Pending (1)
    let res1 = process_stroke_event(b'g', KeyModifiers::empty().bits());
    assert_eq!(res1, 1);

    // Simulate 1000ms pending sequence timeout from JS by calling reset_key_state()
    reset_key_state();

    // Now '0' should be interpreted at base state -> ScrollLeft (action 16, count 1)
    let res2 = process_stroke_event(b'0', KeyModifiers::empty().bits());
    assert_eq!(res2 >> 16, 16);
    assert_eq!(res2 & 0xFFFF, 1);

    // Ctrl+d -> ScrollPageDown (action 12, count 1)
    let res3 = process_stroke_event(b'd', KeyModifiers::CTRL.bits());
    assert_eq!(res3 >> 16, 12);
    assert_eq!(res3 & 0xFFFF, 1);
}

#[test]
fn test_interactive_hint_session_ffi() {
    let _guard = TEST_LOCK.lock().unwrap();
    init_content_engine();

    let candidates = make_candidates(20);
    let buf_ptr = allocate_candidates_buffer(candidates.len());
    unsafe {
        std::ptr::copy_nonoverlapping(candidates.as_ptr(), buf_ptr, candidates.len());
    }

    // Start hint session with action_code = 2 (ClickNewTab)
    let layouts_ptr = start_hint_session(buf_ptr, candidates.len(), 2);
    assert!(!layouts_ptr.is_null());
    assert_eq!(get_layouts_count(), 20);

    let layouts = unsafe { std::slice::from_raw_parts(layouts_ptr, 20) };
    // Find a 2-char hint label
    let two_char = layouts
        .iter()
        .find(|l| l.label_len == 2)
        .copied()
        .expect("20 candidates must produce 2-char hints");

    // Step 1: Type first char -> status 1 (Filtered), matched_len = 1
    let step1 = step_hint_session(two_char.label[0]);
    let status1 = (step1 >> 28) & 0xF;
    let matched_len1 = (step1 >> 16) & 0xFF;
    let active_count1 = step1 & 0xFFFF;
    assert_eq!(status1, 1, "Expected Filtered status (1)");
    assert_eq!(matched_len1, 1);
    assert!(active_count1 >= 1 && active_count1 < 20);

    // Step 2: Type second char -> status 2 (Activate), action = 2 (ClickNewTab), element_id = two_char.element_id
    let step2 = step_hint_session(two_char.label[1]);
    let status2 = (step2 >> 28) & 0xF;
    let action2 = (step2 >> 24) & 0xF;
    let elem_id2 = step2 & 0x00FF_FFFF;
    assert_eq!(status2, 2, "Expected Activate status (2)");
    assert_eq!(action2, 2, "Expected ClickNewTab action (2)");
    assert_eq!(elem_id2 as u32, two_char.element_id);
}
