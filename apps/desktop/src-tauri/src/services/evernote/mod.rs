//! Evernote import — ENEX file parsing, ENML→Markdown conversion, and
//! vault placement. See `parser` for the .enex reader, `enml` for the
//! Markdown converter, and `import` for the high-level orchestrator.

pub mod parser;

// Re-exports become live once `enml` and `import` land in subsequent
// commits; silenced for now to keep the warning gate at zero.
#[allow(unused_imports)]
pub use parser::{parse_enex, parse_enex_bytes, EvernoteNote, Resource};
