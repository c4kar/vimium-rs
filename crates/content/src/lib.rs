use std::sync::Mutex;
use wasm_bindgen::prelude::*;
use vimium_core::{
    CandidateElementRecord, DispatchResult, HintGenerator, HintMarkerLayout,
    KeyAction, KeySequenceEngine,
};

static ENGINE: Mutex<Option<KeySequenceEngine>> = Mutex::new(None);
static CACHED_LAYOUTS: Mutex<Vec<HintMarkerLayout>> = Mutex::new(Vec::new());

#[wasm_bindgen]
pub fn init_content_engine() {
    let mut engine_guard = ENGINE.lock().unwrap();
    *engine_guard = Some(KeySequenceEngine::with_default_bindings());
    web_sys::console::log_1(&"Vimium-RS Content Engine initialized in isolated world.".into());
}

#[wasm_bindgen]
pub fn process_key_event(key_byte: u8) -> i32 {
    let mut engine_guard = ENGINE.lock().unwrap();
    let engine = match engine_guard.as_mut() {
        Some(e) => e,
        None => return -1,
    };

    match engine.process_key(key_byte) {
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
                KeyAction::ScrollPageDown => 12,
                KeyAction::ScrollPageUp => 13,
                KeyAction::ScrollToTop => 14,
                KeyAction::ScrollToBottom => 15,
                KeyAction::LinkHints => 20,
                KeyAction::LinkHintsNewTab => 21,
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

/// Allocates memory in WASM linear memory for candidate records.
#[wasm_bindgen]
pub fn allocate_candidates_buffer(count: usize) -> *mut CandidateElementRecord {
    let mut vec: Vec<CandidateElementRecord> = Vec::with_capacity(count);
    let ptr = vec.as_mut_ptr();
    std::mem::forget(vec);
    ptr
}

/// Computes hint layouts from candidate records in WASM memory.
/// Returns the pointer to the contiguous array of HintMarkerLayout structs.
#[wasm_bindgen]
pub fn compute_hint_layouts(candidates_ptr: *const CandidateElementRecord, count: usize) -> *const HintMarkerLayout {
    if candidates_ptr.is_null() || count == 0 {
        return std::ptr::null();
    }

    let candidates = unsafe { std::slice::from_raw_parts(candidates_ptr, count) };
    let generator = HintGenerator::with_default_alphabet();
    let layouts = generator.compute_layouts(candidates);

    let mut cache = CACHED_LAYOUTS.lock().unwrap();
    *cache = layouts;
    cache.as_ptr()
}

#[wasm_bindgen]
pub fn get_layouts_count() -> usize {
    CACHED_LAYOUTS.lock().unwrap().len()
}
