// Side-effectful services — see architecture.md §8 / §9.

pub mod attachments;
pub mod auth;
pub mod config;
pub mod conflicts;
pub mod evernote;
pub mod fs;
pub mod git;
pub mod index;
pub mod notes;
pub mod sync_state;
pub mod vault_lock;
pub mod workspace;
