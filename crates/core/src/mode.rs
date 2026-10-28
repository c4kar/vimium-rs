#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Normal,
    Insert,
    Visual,
    Find,
    Hints,
    PassNextKey,
}

impl Mode {
    pub fn is_insert(&self) -> bool {
        matches!(self, Mode::Insert)
    }

    pub fn is_hints(&self) -> bool {
        matches!(self, Mode::Hints)
    }
}
