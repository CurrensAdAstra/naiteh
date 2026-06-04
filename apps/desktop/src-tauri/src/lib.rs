mod commands;
mod domain;
mod services;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

const MENU_IMPORT_EVERNOTE: &str = "import_evernote";

/// Native application menu. Keeps the standard app / Edit items (so the
/// editor's cut/copy/paste/select-all work from the menu bar) and adds
/// a File menu with the Evernote import entry. Clicking it emits
/// `menu:import-evernote`, which the frontend turns into the Settings
/// import flow.
fn build_menu<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let import = MenuItem::with_id(
        handle,
        MENU_IMPORT_EVERNOTE,
        "Import from Evernote…",
        true,
        None::<&str>,
    )?;

    let app_menu = Submenu::with_items(
        handle,
        "naiteh",
        true,
        &[
            &PredefinedMenuItem::about(handle, None, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;
    let file_menu = Submenu::with_items(handle, "File", true, &[&import])?;
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    Menu::with_items(handle, &[&app_menu, &file_menu, &edit_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == MENU_IMPORT_EVERNOTE {
                let _ = app.emit("menu:import-evernote", ());
            }
        })
        // Per-vault mutex shared across all write + sync commands; see
        // services::vault_lock and architecture.md §9.
        .manage(services::vault_lock::VaultLocks::default())
        // In-memory tag index; rebuilt lazily, invalidated by writes.
        // See services::index and architecture.md §4.3.
        .manage(services::index::TagIndex::default())
        // Opaque bearer-token session map. See services::auth.
        .manage(services::auth::SessionStore::default())
        .invoke_handler(tauri::generate_handler![
            commands::vault::vault_pick_folder,
            commands::vault::vault_init,
            commands::vault::vault_current,
            commands::vault::vault_set_active,
            commands::vault::vault_list_known,
            commands::auth::auth_login,
            commands::auth::auth_logout,
            commands::auth::auth_list_users,
            commands::auth::auth_set_user_active,
            commands::auth::auth_list_audit_logs,
            commands::auth::auth_log_action,
            commands::journal::quick_create,
            commands::journal::quick_list,
            commands::journal::activity_recent,
            commands::journal::journal_open,
            commands::journal::journal_save,
            commands::journal::journal_month_meta,
            commands::journal::timeline_range,
            commands::journal::timeline_pinned,
            commands::notes::notes_list,
            commands::notes::notes_read,
            commands::notes::notes_write,
            commands::notes::notes_create,
            commands::notes::notes_delete,
            commands::notes::notes_rename,
            commands::notes::notes_set_pinned,
            commands::notes::notes_list_dirs,
            commands::notes::notes_create_dir,
            commands::notes::notes_delete_dir,
            commands::notes::notes_rename_dir,
            commands::tags::tags_list,
            commands::tags::tags_notes,
            commands::search::search_text,
            commands::sync::sync_status,
            commands::sync::sync_init,
            commands::sync::sync_set_remote,
            commands::sync::sync_pull,
            commands::sync::sync_push,
            commands::sync::sync_now,
            commands::sync::sync_list_conflicts,
            commands::sync::sync_resolve_keep_ours,
            commands::sync::sync_resolve_keep_theirs,
            commands::settings::app_config_get,
            commands::settings::app_config_set_editor,
            commands::settings::app_config_set_ai,
            commands::ai::ai_improve,
            commands::ai::ai_list_models,
            commands::attachments::attachments_import,
            commands::attachments::attachments_import_bytes,
            commands::evernote::evernote_import,
            commands::workspace::workspace_get,
            commands::workspace::workspace_set_last_opened,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
