use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn init_background_worker() {
    web_sys::console::log_1(&"Vimium-RS Background Worker initialized.".into());
}

#[wasm_bindgen]
pub fn route_frame_message(from_frame_id: u32, message_type: u32) -> u32 {
    // Route messages across tabs/frames
    message_type ^ from_frame_id
}
