// Pure domain types & errors — see architecture.md §6 / §7.

pub mod error;
pub mod types;

pub use error::AppError;
pub use types::{
    AttachmentImport, AuditLogEntry, AuthSession, AuthUser, DayMeta, JournalOpenResult,
    JournalSaveResult, LegalDocsStatus, NoteMeta, SearchHit, SyncStatus, TagCount, TimelineDay,
    TimelineItem, UserRole, VaultInfo,
};
