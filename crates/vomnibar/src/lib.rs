use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn score_fuzzy_match(query: &str, candidate: &str) -> i32 {
    if query.is_empty() {
        return 0;
    }
    if candidate.starts_with(query) {
        return 100;
    }
    if candidate.contains(query) {
        return 50;
    }
    -1
}
