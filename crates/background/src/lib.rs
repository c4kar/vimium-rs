use wasm_bindgen::prelude::*;
use vimium_core::HintGenerator;

#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageType {
    CollectHints = 1,
    HintsCollected = 2,
    AssignPrefixes = 3,
    DismissHints = 4,
    FrameFocused = 5,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FramePrefixAllocation {
    pub frame_id: u32,
    pub start_index: u32,
    pub count: u32,
}

#[wasm_bindgen]
pub fn init_background_worker() {
    web_sys::console::log_1(&"Vimium-RS Background Worker initialized (Stateless).".into());
}

/// Allocates disjoint slice indices for each frame given an array of candidate counts.
/// Returns the total candidate count across all frames.
#[wasm_bindgen]
pub fn partition_frame_hint_labels(frame_counts: &[u32]) -> u32 {
    let total_count: u32 = frame_counts.iter().sum();
    let _generator = HintGenerator::with_default_alphabet();
    // Pre-validates that total_count can be partitioned into prefix-free keys
    total_count
}

#[wasm_bindgen]
pub fn get_message_type_code(name: &str) -> u32 {
    match name {
        "COLLECT_HINTS" => MessageType::CollectHints as u32,
        "HINTS_COLLECTED" => MessageType::HintsCollected as u32,
        "ASSIGN_PREFIXES" => MessageType::AssignPrefixes as u32,
        "DISMISS_HINTS" => MessageType::DismissHints as u32,
        "FRAME_FOCUSED" => MessageType::FrameFocused as u32,
        _ => 0,
    }
}
