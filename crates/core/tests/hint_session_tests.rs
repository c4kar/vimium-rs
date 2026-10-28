use vimium_core::{
    CandidateElementRecord, ElementFlags,
    hints::{HintAction, HintSession, HintStepResult},
};

fn sample_candidates(count: usize) -> Vec<CandidateElementRecord> {
    (0..count)
        .map(|i| CandidateElementRecord {
            element_id: (i + 100) as u32,
            flags: ElementFlags::CLICKABLE.bits(),
            x: (i as f32) * 40.0,
            y: 50.0,
            width: 35.0,
            height: 20.0,
            weight: 10,
            _pad: 0,
            _reserved: 0,
        })
        .collect()
}

#[test]
fn test_hint_session_single_char_activation() {
    let candidates = sample_candidates(5);
    let mut session = HintSession::new(&candidates, HintAction::ClickCurrentTab);

    assert!(session.is_active());
    assert_eq!(session.layouts().len(), 5);

    // Default alphabet starts with 's', 'a', 'd', 'f', 'j'
    // Typing 'd' (3rd candidate -> element_id 102) should immediately activate
    let step = session.process_key(b'd');
    assert_eq!(
        step,
        HintStepResult::Activate {
            element_id: 102,
            action: HintAction::ClickCurrentTab,
        }
    );
    assert!(!session.is_active());
}

#[test]
fn test_hint_session_multi_char_filtering_and_backspace() {
    // 25 candidates forces 2-character hints for branch nodes
    let candidates = sample_candidates(25);
    let mut session = HintSession::new(&candidates, HintAction::ClickNewTab);

    // Find a 2-character hint from the generated layouts
    let two_char_layout = session
        .layouts()
        .iter()
        .find(|l| l.label_len == 2)
        .copied()
        .expect("Should have 2-character hints for 25 candidates");

    let first_byte = two_char_layout.label[0];
    let second_byte = two_char_layout.label[1];
    let target_id = two_char_layout.element_id;

    // 1. Type first character -> should filter down to matching hints with matched_len = 1
    let step1 = session.process_key(first_byte);
    match step1 {
        HintStepResult::Filtered {
            active_count,
            matched_len,
        } => {
            assert!(active_count >= 1 && active_count < 25);
            assert_eq!(matched_len, 1);
        }
        other => panic!("Expected Filtered, got {:?}", other),
    }

    // 2. Press Backspace (ASCII 8) -> should restore all 25 active hints with matched_len = 0
    let step_back = session.process_key(8);
    assert_eq!(
        step_back,
        HintStepResult::Filtered {
            active_count: 25,
            matched_len: 0,
        }
    );

    // 3. Re-type first character, then second character -> should activate target_id
    let _ = session.process_key(first_byte);
    let step2 = session.process_key(second_byte);
    assert_eq!(
        step2,
        HintStepResult::Activate {
            element_id: target_id,
            action: HintAction::ClickNewTab,
        }
    );
    assert!(!session.is_active());
}

#[test]
fn test_hint_session_escape_and_invalid_key() {
    let candidates = sample_candidates(5);
    let mut session = HintSession::new(&candidates, HintAction::CopyLinkUrl);

    // Typing a character not in any hint ('z') cancels or reports NoMatch
    let step_invalid = session.process_key(b'z');
    assert_eq!(step_invalid, HintStepResult::NoMatch);
    assert!(!session.is_active());

    // Starting a new session and pressing Escape (27) cancels immediately
    let mut session2 = HintSession::new(&candidates, HintAction::CopyLinkUrl);
    assert_eq!(session2.process_key(27), HintStepResult::Cancelled);
    assert!(!session2.is_active());
}
