//! naiteh-core — the engine core: vault I/O, notes/journal/tags, git sync,
//! auth, attachments, Evernote import, CLI hooks, and AI Assist.
//!
//! Deliberately **Tauri-free** (docs/design/engine-daemon.md §11): the same
//! crate serves the desktop shell today and the headless engine daemon later.
//! The desktop app's `commands/` layer wraps these services in thin Tauri IPC
//! functions; nothing here may depend on a UI or on Tauri state types.

pub mod domain;
pub mod services;
