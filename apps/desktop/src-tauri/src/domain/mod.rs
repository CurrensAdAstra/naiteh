// Pure domain types & errors — see vault/wiki/domain-model.md (types) and
// vault/wiki/ipc-api.md (`AppError`).
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
pub mod watch;

pub use attachment::AttachmentImport;
pub use auth::{AuditLogEntry, AuthAccess, AuthSession, LoginResult, UserRole};
pub use error::AppError;
pub use evernote::{EvernoteImportReport, EvernoteImportedNote};
pub use journal::{
    DayMeta, DocKind, JournalOpenResult, JournalSaveResult, Placement, TimelineDay, TimelineItem,
};
pub use note::{NoteDocument, NoteMeta, NoteWriteResult};
pub use search::{SearchHit, TagCount};
pub use sync::SyncStatus;
pub use vault::VaultInfo;
pub use watch::{ChangeKind, VaultChange, VaultChanged, VaultWatchError};
