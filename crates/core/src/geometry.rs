use smallvec::SmallVec;

bitflags::bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
    pub struct ElementFlags: u32 {
        const CLICKABLE   = 1 << 0;
        const LINK        = 1 << 1;
        const INPUT       = 1 << 2;
        const SCROLLABLE  = 1 << 3;
        const IN_IFRAME   = 1 << 4;
        const SHADOW_HOST = 1 << 5;
    }
}

/// 32-byte cache-aligned record passed from the JS DOM collector into WASM linear memory.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CandidateElementRecord {
    pub element_id: u32,
    pub flags: u32,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub weight: u16,
    pub _pad: u16,
    pub _reserved: u32,
}

/// 24-byte layout struct emitted by Rust hint generation and read directly by the JS renderer.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HintMarkerLayout {
    pub element_id: u32,
    pub x: f32,
    pub y: f32,
    pub label_len: u8,
    pub label: [u8; 7],
    pub flags: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

impl Rect {
    pub fn new(left: f32, top: f32, right: f32, bottom: f32) -> Self {
        Self { left, top, right, bottom }
    }

    pub fn from_origin_size(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            left: x,
            top: y,
            right: x + width,
            bottom: y + height,
        }
    }

    pub fn width(&self) -> f32 {
        (self.right - self.left).max(0.0)
    }

    pub fn height(&self) -> f32 {
        (self.bottom - self.top).max(0.0)
    }

    pub fn area(&self) -> f32 {
        self.width() * self.height()
    }

    pub fn intersects(&self, other: &Rect) -> bool {
        self.left < other.right
            && self.right > other.left
            && self.top < other.bottom
            && self.bottom > other.top
    }

    pub fn contains_rect(&self, other: &Rect) -> bool {
        self.left <= other.left
            && self.right >= other.right
            && self.top <= other.top
            && self.bottom >= other.bottom
    }

    /// Subtracts `sub` from `self`, returning up to 4 non-overlapping constituent sub-rectangles.
    pub fn subtract(&self, sub: &Rect) -> SmallVec<[Rect; 4]> {
        let mut result = SmallVec::new();
        if !self.intersects(sub) {
            result.push(*self);
            return result;
        }

        // Top band
        if sub.top > self.top {
            result.push(Rect::new(self.left, self.top, self.right, sub.top));
        }

        // Bottom band
        if sub.bottom < self.bottom {
            result.push(Rect::new(self.left, sub.bottom, self.right, self.bottom));
        }

        // Left middle band
        let mid_top = self.top.max(sub.top);
        let mid_bottom = self.bottom.min(sub.bottom);
        if sub.left > self.left {
            result.push(Rect::new(self.left, mid_top, sub.left, mid_bottom));
        }

        // Right middle band
        if sub.right < self.right {
            result.push(Rect::new(sub.right, mid_top, self.right, mid_bottom));
        }

        result
    }
}
