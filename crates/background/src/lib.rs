use std::sync::Mutex;
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

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FramePrefixAllocation {
    pub frame_id: u32,
    pub start_index: u32,
    pub count: u32,
}

static FRAME_COUNTS_BUF: Mutex<Vec<u32>> = Mutex::new(Vec::new());
static FRAME_OFFSETS_BUF: Mutex<Vec<u32>> = Mutex::new(Vec::new());

#[unsafe(no_mangle)]
pub extern "C" fn init_background_worker() {}

/// Computes prefix-free start indices for each `(frame_id, count)` pair.
/// Returns `(total_count, Vec<FramePrefixAllocation>)`.
pub fn compute_frame_allocations(frames: &[(u32, u32)]) -> (u32, Vec<FramePrefixAllocation>) {
    let mut running_offset = 0u32;
    let mut allocations = Vec::with_capacity(frames.len());
    for &(frame_id, count) in frames {
        allocations.push(FramePrefixAllocation {
            frame_id,
            start_index: running_offset,
            count,
        });
        running_offset = running_offset.saturating_add(count);
    }
    let _generator = HintGenerator::with_default_alphabet();
    (running_offset, allocations)
}

#[unsafe(no_mangle)]
pub extern "C" fn allocate_frame_counts_buffer(len: usize) -> *mut u32 {
    let mut buf = FRAME_COUNTS_BUF.lock().unwrap();
    if buf.capacity() < len {
        let extra = len - buf.len();
        buf.reserve(extra);
    }
    unsafe {
        buf.set_len(len);
    }
    buf.as_mut_ptr()
}

/// Given `len` frame candidate counts in `counts_ptr`, writes each frame's `start_index`
/// into the internal offsets buffer and returns `total_count`.
#[unsafe(no_mangle)]
pub extern "C" fn compute_frame_offsets(counts_ptr: *const u32, len: usize) -> u32 {
    if counts_ptr.is_null() || len == 0 {
        return 0;
    }
    let counts = unsafe { std::slice::from_raw_parts(counts_ptr, len) };
    let mut offsets = FRAME_OFFSETS_BUF.lock().unwrap();
    offsets.clear();
    offsets.reserve(len);

    let mut total = 0u32;
    for &c in counts {
        offsets.push(total);
        total = total.saturating_add(c);
    }
    total
}

#[unsafe(no_mangle)]
pub extern "C" fn get_frame_offsets_ptr() -> *const u32 {
    FRAME_OFFSETS_BUF.lock().unwrap().as_ptr()
}
