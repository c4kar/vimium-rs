use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use vimium_core::{
    CandidateElementRecord, DispatchResult, HintAction, HintGenerator, HintMarkerLayout,
    HintSession, HintStepResult, KeyAction, KeyModifiers, KeySequenceEngine, KeyStroke, Mode,
};

struct SendBuffer(Vec<CandidateElementRecord>);
unsafe impl Send for SendBuffer {}

static ENGINE: Mutex<Option<KeySequenceEngine>> = Mutex::new(None);
static CANDIDATE_BUFFER: Mutex<SendBuffer> = Mutex::new(SendBuffer(Vec::new()));
static CACHED_LAYOUTS: Mutex<Vec<HintMarkerLayout>> = Mutex::new(Vec::new());
static HINT_SESSION: Mutex<Option<HintSession>> = Mutex::new(None);
static LAYOUTS_LEN: AtomicUsize = AtomicUsize::new(0);

#[unsafe(no_mangle)]
pub extern "C" fn init_content_engine() {
    let mut engine_guard = ENGINE.lock().unwrap();
    *engine_guard = Some(KeySequenceEngine::with_default_bindings());
}

fn encode_dispatch_result(res: DispatchResult) -> i32 {
    match res {
        DispatchResult::PassThrough => 0,
        DispatchResult::Pending => 1,
        DispatchResult::Cancelled => 2,
        DispatchResult::Execute { action, count } => {
            // Encode action and count into 32-bit return: (action_id << 16) | (count & 0xFFFF)
            let action_id = match action {
                KeyAction::ScrollDown => 10,
                KeyAction::ScrollUp => 11,
                KeyAction::ScrollLeft => 16,
                KeyAction::ScrollRight => 17,
                KeyAction::ScrollHalfPageLeft => 18,
                KeyAction::ScrollHalfPageRight => 19,
                KeyAction::ScrollPageDown => 12,
                KeyAction::ScrollPageUp => 13,
                KeyAction::ScrollToTop => 14,
                KeyAction::ScrollToBottom => 15,
                KeyAction::HistoryBack => 22,
                KeyAction::HistoryForward => 23,
                KeyAction::ReloadTab => 24,
                KeyAction::ReloadTabHard => 25,
                KeyAction::GoUpUrl => 26,
                KeyAction::GoToRootUrl => 27,
                KeyAction::CreateTab => 60,
                KeyAction::PreviousTab => 61,
                KeyAction::NextTab => 62,
                KeyAction::CloseTab => 63,
                KeyAction::RestoreTab => 64,
                KeyAction::DuplicateTab => 65,
                KeyAction::MoveTabLeft => 66,
                KeyAction::MoveTabRight => 67,
                KeyAction::LinkHints => 20,
                KeyAction::LinkHintsNewTab => 21,
                KeyAction::CopyCurrentUrl => 70,
                KeyAction::CopyLinkUrl => 71,
                KeyAction::OpenFromClipboard => 72,
                KeyAction::OpenFromClipboardNewTab => 73,
                KeyAction::Vomnibar => 30,
                KeyAction::EnterInsertMode => 40,
                KeyAction::EnterVisualMode => 41,
                KeyAction::EnterFindMode => 42,
                KeyAction::ExitMode => 43,
                KeyAction::PassNextKey => 50,
                KeyAction::Custom(id) => 100 + id,
            };
            ((action_id as i32) << 16) | ((count & 0xFFFF) as i32)
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn process_key_event(key_byte: u8) -> i32 {
    process_stroke_event(key_byte, 0)
}

#[unsafe(no_mangle)]
pub extern "C" fn process_stroke_event(key_byte: u8, modifiers: u8) -> i32 {
    let mut engine_guard = ENGINE.lock().unwrap();
    let engine = match engine_guard.as_mut() {
        Some(e) => e,
        None => return -1,
    };

    let mods = KeyModifiers::from_bits_truncate(modifiers);
    let stroke = KeyStroke::new(key_byte, mods);
    encode_dispatch_result(engine.process_stroke(stroke))
}

#[unsafe(no_mangle)]
pub extern "C" fn reset_key_state() {
    if let Some(engine) = ENGINE.lock().unwrap().as_mut() {
        engine.reset_state();
    }
}

/// Allocates or reuses a contiguous buffer in WASM linear memory for candidate records.
#[unsafe(no_mangle)]
pub extern "C" fn allocate_candidates_buffer(count: usize) -> *mut CandidateElementRecord {
    let mut buf = CANDIDATE_BUFFER.lock().unwrap();
    if buf.0.capacity() < count {
        let extra = count - buf.0.len();
        buf.0.reserve(extra);
    }
    unsafe {
        buf.0.set_len(count);
    }
    buf.0.as_mut_ptr()
}

/// Computes hint layouts from candidate records in WASM memory.
/// Returns the pointer to the contiguous array of HintMarkerLayout structs.
#[unsafe(no_mangle)]
pub extern "C" fn compute_hint_layouts(
    candidates_ptr: *const CandidateElementRecord,
    count: usize,
) -> *const HintMarkerLayout {
    if candidates_ptr.is_null() || count == 0 {
        return std::ptr::null();
    }

    let candidates = unsafe { std::slice::from_raw_parts(candidates_ptr, count) };
    let generator = HintGenerator::with_default_alphabet();
    let layouts = generator.compute_layouts(candidates);

    let mut cache = CACHED_LAYOUTS.lock().unwrap();
    LAYOUTS_LEN.store(layouts.len(), Ordering::SeqCst);
    *cache = layouts;
    cache.as_ptr()
}

/// Starts an interactive `HintSession` in WASM linear memory and transitions the engine to `Mode::Hints`.
/// Returns a pointer to the session's `HintMarkerLayout` array.
#[unsafe(no_mangle)]
pub extern "C" fn start_hint_session(
    candidates_ptr: *const CandidateElementRecord,
    count: usize,
    action_code: u8,
) -> *const HintMarkerLayout {
    if candidates_ptr.is_null() || count == 0 {
        return std::ptr::null();
    }

    let candidates = unsafe { std::slice::from_raw_parts(candidates_ptr, count) };
    let action = HintAction::from_u8(action_code);
    let session = HintSession::new(candidates, action);
    let ptr = session.layouts_ptr();
    let len = session.layouts().len();

    if let Some(engine) = ENGINE.lock().unwrap().as_mut() {
        engine.enter_transient_mode(Mode::Hints);
    }

    let mut session_guard = HINT_SESSION.lock().unwrap();
    *session_guard = Some(session);
    drop(session_guard);

    LAYOUTS_LEN.store(len, std::sync::atomic::Ordering::SeqCst);
    ptr
}

/// Processes a keystroke in the active `HintSession`.
/// Encodes the result into a 32-bit integer:
/// - `0`: Cancelled
/// - `3`: NoMatch
/// - `(1 << 28) | ((matched_len as i32) << 16) | ((active_count as i32) & 0xFFFF)`: Filtered
/// - `(2 << 28) | ((action as i32) << 24) | ((element_id as i32) & 0x00FF_FFFF)`: Activate
#[unsafe(no_mangle)]
pub extern "C" fn step_hint_session(key_byte: u8) -> i32 {
    let mut session_guard = HINT_SESSION.lock().unwrap();
    let session = match session_guard.as_mut() {
        Some(s) => s,
        None => return 0,
    };

    let result = session.process_key(key_byte);

    match result {
        HintStepResult::Cancelled => {
            *session_guard = None;
            if let Some(engine) = ENGINE.lock().unwrap().as_mut() {
                engine.exit_transient_mode();
            }
            0
        }
        HintStepResult::NoMatch => {
            *session_guard = None;
            if let Some(engine) = ENGINE.lock().unwrap().as_mut() {
                engine.exit_transient_mode();
            }
            3
        }
        HintStepResult::Filtered {
            active_count,
            matched_len,
        } => {
            (1 << 28)
                | (((matched_len as i32) & 0xFF) << 16)
                | ((active_count as i32) & 0xFFFF)
        }
        HintStepResult::Activate { element_id, action } => {
            *session_guard = None;
            if let Some(engine) = ENGINE.lock().unwrap().as_mut() {
                engine.exit_transient_mode();
            }
            (2 << 28)
                | (((action as i32) & 0xF) << 24)
                | ((element_id as i32) & 0x00FF_FFFF)
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn get_layouts_count() -> usize {
    LAYOUTS_LEN.load(Ordering::SeqCst)
}
