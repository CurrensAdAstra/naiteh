mod commands;
mod domain;
mod services;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::vault::vault_pick_folder,
            commands::vault::vault_init,
            commands::vault::vault_current,
            commands::vault::vault_set_active,
            commands::vault::vault_list_known,
            commands::auth::auth_login,
            commands::auth::auth_list_users,
            commands::auth::auth_set_user_active,
            commands::auth::auth_list_audit_logs,
            commands::auth::auth_log_action,
            commands::rag::legal_docs_status,
            commands::rag::legal_docs_sync,
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
            commands::tags::tags_list,
            commands::tags::tags_notes,
            commands::search::search_text,
            commands::sync::sync_status,
            commands::sync::sync_init,
            commands::sync::sync_set_remote,
            commands::sync::sync_pull,
            commands::sync::sync_push,
            commands::sync::sync_now,
            commands::settings::app_config_get,
            commands::settings::app_config_set_editor,
            commands::settings::app_config_set_ai,
            commands::ai::ai_improve,
            commands::attachments::attachments_import,
            commands::attachments::attachments_import_bytes,
            commands::evernote::evernote_import,
            commands::workspace::workspace_get,
            commands::workspace::workspace_set_last_opened,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
