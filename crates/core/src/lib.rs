pub mod geometry;
pub mod hints;
pub mod keys;
pub mod mode;

pub use geometry::{CandidateElementRecord, ElementFlags, HintMarkerLayout, Rect};
pub use hints::{HintGenerator, HintLabel, DEFAULT_HINT_CHARACTERS};
pub use keys::{DispatchResult, ExclusionFilter, KeyAction, KeyModifiers, KeySequenceEngine, KeyStroke, KeyTrie};
pub use mode::Mode;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hint_generator_prefix_free() {
        let generator = HintGenerator::with_default_alphabet();
        let count = 40;
        let labels = generator.generate_labels(count);

        assert_eq!(labels.len(), count);

        // Verify uniqueness
        let str_labels: Vec<&str> = labels.iter().map(|l| l.as_str()).collect();
        for i in 0..count {
            for j in (i + 1)..count {
                assert_ne!(str_labels[i], str_labels[j], "Duplicate labels found");
                assert!(
                    !str_labels[j].starts_with(str_labels[i]),
                    "Label {} is prefix of {}",
                    str_labels[i],
                    str_labels[j]
                );
                assert!(
                    !str_labels[i].starts_with(str_labels[j]),
                    "Label {} is prefix of {}",
                    str_labels[j],
                    str_labels[i]
                );
            }
        }
    }

    #[test]
    fn test_key_sequence_matching_with_counts() {
        let mut engine = KeySequenceEngine::with_default_bindings();

        // Single key: 'j' -> ScrollDown count 1
        assert_eq!(
            engine.process_key(b'j'),
            DispatchResult::Execute {
                action: KeyAction::ScrollDown,
                count: 1
            }
        );

        // Strict Vim '0': when no count has started, '0' is ScrollLeft
        assert_eq!(
            engine.process_key(b'0'),
            DispatchResult::Execute {
                action: KeyAction::ScrollLeft,
                count: 1
            }
        );

        // Count prefix: '1', '0', 'j' -> ScrollDown count 10
        assert_eq!(engine.process_key(b'1'), DispatchResult::Pending);
        assert_eq!(engine.process_key(b'0'), DispatchResult::Pending);
        assert_eq!(
            engine.process_key(b'j'),
            DispatchResult::Execute {
                action: KeyAction::ScrollDown,
                count: 10
            }
        );

        // Multi-key: 'g', 'g' -> ScrollToTop
        assert_eq!(engine.process_key(b'g'), DispatchResult::Pending);
        assert_eq!(
            engine.process_key(b'g'),
            DispatchResult::Execute {
                action: KeyAction::ScrollToTop,
                count: 1
            }
        );

        // Unbound key: 'z' -> PassThrough
        assert_eq!(engine.process_key(b'z'), DispatchResult::PassThrough);
    }

    #[test]
    fn test_exclusion_filter() {
        let mut engine = KeySequenceEngine::with_default_bindings();
        let mut filter = ExclusionFilter::none();
        filter.add_pass_key(b'j'); // Pass 'j' on Gmail
        engine.set_exclusion_filter(filter);

        // 'j' should now pass through to the page
        assert_eq!(engine.process_key(b'j'), DispatchResult::PassThrough);

        // 'k' should still execute ScrollUp
        assert_eq!(
            engine.process_key(b'k'),
            DispatchResult::Execute {
                action: KeyAction::ScrollUp,
                count: 1
            }
        );
    }

    #[test]
    fn test_modal_suspension_stack() {
        let mut engine = KeySequenceEngine::with_default_bindings();

        // Switch persistent mode to Visual mode
        engine.set_mode(Mode::Visual);
        assert_eq!(engine.mode(), Mode::Visual);

        // Trigger transient Hints mode from Visual mode
        engine.enter_transient_mode(Mode::Hints);
        assert_eq!(engine.mode(), Mode::Hints);

        // Esc or dismiss resumes Visual mode, not Normal
        assert_eq!(engine.process_key(27), DispatchResult::Cancelled);
        assert_eq!(engine.mode(), Mode::Visual);
    }

    #[test]
    fn test_rect_subtraction() {
        let r1 = Rect::new(0.0, 0.0, 100.0, 100.0);
        let r2 = Rect::new(20.0, 20.0, 80.0, 80.0);
        let pieces = r1.subtract(&r2);

        // Should split into top, bottom, left, right bands
        assert_eq!(pieces.len(), 4);
    }
}
