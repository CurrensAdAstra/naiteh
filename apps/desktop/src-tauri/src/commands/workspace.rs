//! Per-vault workspace IPC — currently just "the last opened file" so
//! the editor can restore where the user left off.

use crate::domain::AppError;
use crate::services::config;
use crate::services::session::{require_session, ActiveSession};
use crate::services::workspace::{self, LastOpened, WorkspaceState};

#[tauri::command]
pub fn workspace_get(active: tauri::State<'_, ActiveSession>) -> Result<WorkspaceState, AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    workspace::load(&vault_root)
}

#[tauri::command]
pub fn workspace_set_last_opened(
    active: tauri::State<'_, ActiveSession>,
    last_opened: Option<LastOpened>,
) -> Result<WorkspaceState, AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    workspace::set_last_opened(&vault_root, last_opened)
}
