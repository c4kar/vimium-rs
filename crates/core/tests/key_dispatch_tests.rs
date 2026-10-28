use vimium_core::{DispatchResult, KeyAction, KeyModifiers, KeySequenceEngine, KeyStroke};

#[test]
fn test_full_vimium_navigation_motions() {
    let mut engine = KeySequenceEngine::with_default_bindings();

    // Horizontal motions
    assert_eq!(
        engine.process_key(b'h'),
        DispatchResult::Execute {
            action: KeyAction::ScrollLeft,
            count: 1
        }
    );
    assert_eq!(
        engine.process_key(b'l'),
        DispatchResult::Execute {
            action: KeyAction::ScrollRight,
            count: 1
        }
    );
    assert_eq!(
        engine.process_key(b'0'),
        DispatchResult::Execute {
            action: KeyAction::ScrollLeft,
            count: 1
        }
    );
    assert_eq!(
        engine.process_key(b'$'),
        DispatchResult::Execute {
            action: KeyAction::ScrollRight,
            count: 1
        }
    );

    // Multi-key scrolling: 'z', 'H' -> ScrollHalfPageLeft
    assert_eq!(engine.process_key(b'z'), DispatchResult::Pending);
    assert_eq!(
        engine.process_key(b'H'),
        DispatchResult::Execute {
            action: KeyAction::ScrollHalfPageLeft,
            count: 1
        }
    );
}

#[test]
fn test_history_and_url_hierarchy_commands() {
    let mut engine = KeySequenceEngine::with_default_bindings();

    // H -> HistoryBack, L -> HistoryForward
    assert_eq!(
        engine.process_key(b'H'),
        DispatchResult::Execute {
            action: KeyAction::HistoryBack,
            count: 1
        }
    );
    assert_eq!(
        engine.process_key(b'L'),
        DispatchResult::Execute {
            action: KeyAction::HistoryForward,
            count: 1
        }
    );

    // r -> ReloadTab, R -> ReloadTabHard
    assert_eq!(
        engine.process_key(b'r'),
        DispatchResult::Execute {
            action: KeyAction::ReloadTab,
            count: 1
        }
    );
    assert_eq!(
        engine.process_key(b'R'),
        DispatchResult::Execute {
            action: KeyAction::ReloadTabHard,
            count: 1
        }
    );

    // gu -> GoUpUrl, gU -> GoToRootUrl
    assert_eq!(engine.process_key(b'g'), DispatchResult::Pending);
    assert_eq!(
        engine.process_key(b'u'),
        DispatchResult::Execute {
            action: KeyAction::GoUpUrl,
            count: 1
        }
    );

    assert_eq!(engine.process_key(b'g'), DispatchResult::Pending);
    assert_eq!(
        engine.process_key(b'U'),
        DispatchResult::Execute {
            action: KeyAction::GoToRootUrl,
            count: 1
        }
    );
}

#[test]
fn test_tab_operations_and_counts() {
    let mut engine = KeySequenceEngine::with_default_bindings();

    // t -> CreateTab
    assert_eq!(
        engine.process_key(b't'),
        DispatchResult::Execute {
            action: KeyAction::CreateTab,
            count: 1
        }
    );

    // J -> PreviousTab, K -> NextTab
    assert_eq!(
        engine.process_key(b'J'),
        DispatchResult::Execute {
            action: KeyAction::PreviousTab,
            count: 1
        }
    );
    assert_eq!(
        engine.process_key(b'K'),
        DispatchResult::Execute {
            action: KeyAction::NextTab,
            count: 1
        }
    );

    // 3x -> CloseTab count=3
    assert_eq!(engine.process_key(b'3'), DispatchResult::Pending);
    assert_eq!(
        engine.process_key(b'x'),
        DispatchResult::Execute {
            action: KeyAction::CloseTab,
            count: 3
        }
    );

    // X -> RestoreTab
    assert_eq!(
        engine.process_key(b'X'),
        DispatchResult::Execute {
            action: KeyAction::RestoreTab,
            count: 1
        }
    );

    // yt -> DuplicateTab
    assert_eq!(engine.process_key(b'y'), DispatchResult::Pending);
    assert_eq!(
        engine.process_key(b't'),
        DispatchResult::Execute {
            action: KeyAction::DuplicateTab,
            count: 1
        }
    );

    // << and >> -> MoveTabLeft, MoveTabRight
    assert_eq!(engine.process_key(b'<'), DispatchResult::Pending);
    assert_eq!(
        engine.process_key(b'<'),
        DispatchResult::Execute {
            action: KeyAction::MoveTabLeft,
            count: 1
        }
    );

    assert_eq!(engine.process_key(b'>'), DispatchResult::Pending);
    assert_eq!(
        engine.process_key(b'>'),
        DispatchResult::Execute {
            action: KeyAction::MoveTabRight,
            count: 1
        }
    );
}

#[test]
fn test_clipboard_and_link_copy() {
    let mut engine = KeySequenceEngine::with_default_bindings();

    // yy -> CopyCurrentUrl
    assert_eq!(engine.process_key(b'y'), DispatchResult::Pending);
    assert_eq!(
        engine.process_key(b'y'),
        DispatchResult::Execute {
            action: KeyAction::CopyCurrentUrl,
            count: 1
        }
    );

    // yf -> CopyLinkUrl
    assert_eq!(engine.process_key(b'y'), DispatchResult::Pending);
    assert_eq!(
        engine.process_key(b'f'),
        DispatchResult::Execute {
            action: KeyAction::CopyLinkUrl,
            count: 1
        }
    );

    // p -> OpenFromClipboard, P -> OpenFromClipboardNewTab
    assert_eq!(
        engine.process_key(b'p'),
        DispatchResult::Execute {
            action: KeyAction::OpenFromClipboard,
            count: 1
        }
    );
    assert_eq!(
        engine.process_key(b'P'),
        DispatchResult::Execute {
            action: KeyAction::OpenFromClipboardNewTab,
            count: 1
        }
    );
}

#[test]
fn test_ctrl_modifier_keystrokes() {
    let mut engine = KeySequenceEngine::with_default_bindings();

    // Ctrl-d -> ScrollPageDown
    let ctrl_d = KeyStroke::new(b'd', KeyModifiers::CTRL);
    assert_eq!(
        engine.process_stroke(ctrl_d),
        DispatchResult::Execute {
            action: KeyAction::ScrollPageDown,
            count: 1
        }
    );

    // Ctrl-u -> ScrollPageUp
    let ctrl_u = KeyStroke::new(b'u', KeyModifiers::CTRL);
    assert_eq!(
        engine.process_stroke(ctrl_u),
        DispatchResult::Execute {
            action: KeyAction::ScrollPageUp,
            count: 1
        }
    );
}
