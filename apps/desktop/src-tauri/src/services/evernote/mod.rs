//! Evernote import — ENEX file parsing, ENML→Markdown conversion, and
//! vault placement. See `parser` for the .enex reader, `enml` for the
//! Markdown converter, and `import` for the high-level orchestrator.

pub mod enml;
pub mod parser;

// Re-exports become live once `import` lands in C3; silenced for now
// to keep the warning gate at zero.
#[allow(unused_imports)]
pub use enml::enml_to_markdown;
#[allow(unused_imports)]
pub use parser::{parse_enex, parse_enex_bytes, EvernoteNote, Resource};
