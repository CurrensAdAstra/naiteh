// Pure domain types & errors — see architecture.md §6 / §7.
//
// Types are grouped by area into one module each; everything is
// re-exported flat as `crate::domain::Foo` so call sites don't care
// where a type physically lives.

pub mod attachment;
pub mod auth;
pub mod error;
pub mod evernote;
pub mod journal;
pub mod note;
pub mod search;
pub mod sync;
pub mod vault;

pub use attachment::AttachmentImport;
pub use auth::{AuditLogEntry, AuthSession, AuthUser, LoginResult, UserRole};
pub use error::AppError;
pub use evernote::{EvernoteImportReport, EvernoteImportedNote};
pub use journal::{DayMeta, JournalOpenResult, JournalSaveResult, TimelineDay, TimelineItem};
pub use note::NoteMeta;
pub use search::{SearchHit, TagCount};
pub use sync::SyncStatus;
pub use vault::VaultInfo;
