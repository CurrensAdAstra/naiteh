//! RAG source management commands.

use crate::domain::{AppError, LegalDocsStatus};
use crate::services::{config, fs as fsx, legal_docs};

fn app_data_dir() -> Result<std::path::PathBuf, AppError> {
    let dir = config::default_app_data_dir()?;
    fsx::ensure_dir(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub fn legal_docs_status() -> Result<LegalDocsStatus, AppError> {
    let dir = app_data_dir()?;
    legal_docs::status(&dir)
}

#[tauri::command]
pub fn legal_docs_sync() -> Result<LegalDocsStatus, AppError> {
    let dir = app_data_dir()?;
    legal_docs::sync(&dir)
}
