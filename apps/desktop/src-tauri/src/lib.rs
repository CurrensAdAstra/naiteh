mod commands;
mod domain;
mod services;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

const MENU_IMPORT_EVERNOTE: &str = "import_evernote";
const MENU_NEW_NOTE: &str = "new_note";
const MENU_NEW_FOLDER: &str = "new_folder";
const MENU_COMMAND_PALETTE: &str = "command_palette";
const MENU_AI_CHAT_SEND: &str = "ai_chat_send";
const MENU_AI_NEW_CHAT: &str = "ai_new_chat";
const MENU_AI_SELECT_MODEL: &str = "ai_select_model";
const MENU_AI_STOP: &str = "ai_stop";
const MENU_TOGGLE_EDIT: &str = "toggle_edit";
const MENU_SETTINGS: &str = "settings";
const VIEW_ID_PREFIX: &str = "view:";

/// (id-suffix, label, accelerator) for the six view-switch entries.
/// Order + shortcuts match the Activity Bar.
const VIEW_ITEMS: &[(&str, &str, &str)] = &[
    ("journal", "Journal", "CmdOrCtrl+1"),
    ("notes", "Notes", "CmdOrCtrl+2"),
    ("calendar", "Calendar", "CmdOrCtrl+3"),
    ("search", "Search", "CmdOrCtrl+4"),
    ("tags", "Tags", "CmdOrCtrl+5"),
    ("sync", "Sync", "CmdOrCtrl+6"),
];

/// Native application menu. Standard App / Edit submenus (so the editor's
/// undo/cut/copy/paste/select-all work from the menu bar with their usual
/// shortcuts), a File menu (new note/folder + Evernote import), and a
/// View menu that switches panels, toggles the palette and the note
/// view/edit mode, and drives chat-in-note AI (Chat / New Chat / Select
/// Model… / Stop Streaming).
/// Custom items carry accelerators and emit `menu:*` events the frontend
/// routes to store actions.
fn build_menu<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = Submenu::with_items(
        handle,
        "naiteh",
        true,
        &[
            &PredefinedMenuItem::about(handle, None, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(
                handle,
                MENU_SETTINGS,
                "Settings…",
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let new_note = MenuItem::with_id(handle, MENU_NEW_NOTE, "New Note", true, Some("CmdOrCtrl+N"))?;
    let new_folder = MenuItem::with_id(
        handle,
        MENU_NEW_FOLDER,
        "New Folder",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let import = MenuItem::with_id(
        handle,
        MENU_IMPORT_EVERNOTE,
        "Import from Evernote…",
        true,
        None::<&str>,
    )?;
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &new_note,
            &new_folder,
            &PredefinedMenuItem::separator(handle)?,
            &import,
        ],
    )?;

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

    // View menu: the six panels, then palette, AI and edit-mode toggles.
    let view_items: Vec<MenuItem<R>> = VIEW_ITEMS
        .iter()
        .map(|(id, label, accel)| {
            MenuItem::with_id(
                handle,
                format!("{VIEW_ID_PREFIX}{id}"),
                *label,
                true,
                Some(*accel),
            )
        })
        .collect::<tauri::Result<_>>()?;
    let command_palette = MenuItem::with_id(
        handle,
        MENU_COMMAND_PALETTE,
        "Command Palette…",
        true,
        Some("CmdOrCtrl+P"),
    )?;
    // Chat-in-note (chatgpt-md port; wiki ipc-api.md, "AI chat"). The
    // frontend acts on the active note.
    let ai_chat_send =
        MenuItem::with_id(handle, MENU_AI_CHAT_SEND, "Chat", true, Some("CmdOrCtrl+J"))?;
    let ai_new_chat = MenuItem::with_id(
        handle,
        MENU_AI_NEW_CHAT,
        "New Chat",
        true,
        Some("CmdOrCtrl+Shift+J"),
    )?;
    let ai_select_model = MenuItem::with_id(
        handle,
        MENU_AI_SELECT_MODEL,
        "Select Model…",
        true,
        None::<&str>,
    )?;
    let ai_stop = MenuItem::with_id(handle, MENU_AI_STOP, "Stop Streaming", true, None::<&str>)?;
    let toggle_edit = MenuItem::with_id(
        handle,
        MENU_TOGGLE_EDIT,
        "Toggle Edit Mode",
        true,
        Some("CmdOrCtrl+Shift+E"),
    )?;
    let separator = PredefinedMenuItem::separator(handle)?;
    let ai_separator = PredefinedMenuItem::separator(handle)?;
    let mut view_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = view_items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<R>)
        .collect();
    view_refs.push(&separator);
    view_refs.push(&command_palette);
    view_refs.push(&toggle_edit);
    view_refs.push(&ai_separator);
    view_refs.push(&ai_chat_send);
    view_refs.push(&ai_new_chat);
    view_refs.push(&ai_select_model);
    view_refs.push(&ai_stop);
    let view_menu = Submenu::with_items(handle, "View", true, &view_refs)?;

    Menu::with_items(handle, &[&app_menu, &file_menu, &edit_menu, &view_menu])
}

/// The result of routing a menu id to a frontend event channel. Split
/// out from `emit_menu_event` so the id→channel mapping is unit-testable
/// without an `AppHandle`.
enum MenuRoute {
    /// A view-switch: `menu:view` with the mode string as payload.
    View(String),
    /// A unit-payload event on the named channel.
    Unit(&'static str),
    /// Unknown id — ignore.
    None,
}

fn route_menu_id(id: &str) -> MenuRoute {
    if let Some(mode) = id.strip_prefix(VIEW_ID_PREFIX) {
        return MenuRoute::View(mode.to_string());
    }
    match id {
        MENU_NEW_NOTE => MenuRoute::Unit("menu:new-note"),
        MENU_NEW_FOLDER => MenuRoute::Unit("menu:new-folder"),
        MENU_COMMAND_PALETTE => MenuRoute::Unit("menu:command-palette"),
        MENU_AI_CHAT_SEND => MenuRoute::Unit("menu:ai-chat-send"),
        MENU_AI_NEW_CHAT => MenuRoute::Unit("menu:ai-new-chat"),
        MENU_AI_SELECT_MODEL => MenuRoute::Unit("menu:ai-select-model"),
        MENU_AI_STOP => MenuRoute::Unit("menu:ai-stop"),
        MENU_TOGGLE_EDIT => MenuRoute::Unit("menu:toggle-edit"),
        MENU_SETTINGS => MenuRoute::Unit("menu:settings"),
        MENU_IMPORT_EVERNOTE => MenuRoute::Unit("menu:import-evernote"),
        _ => MenuRoute::None,
    }
}

fn emit_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match route_menu_id(id) {
        MenuRoute::View(mode) => {
            let _ = app.emit("menu:view", mode);
        }
        MenuRoute::Unit(event) => {
            let _ = app.emit(event, ());
        }
        MenuRoute::None => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            emit_menu_event(app, event.id().as_ref());
        })
        // Per-vault mutex shared across all write + sync commands; see
        // services::vault_lock and vault/wiki/concurrency-safety.md.
        .manage(services::vault_lock::VaultLocks::default())
        // In-memory tag index; rebuilt lazily, invalidated by writes.
        // See services::index and vault/wiki/concurrency-safety.md
        // ("Tag index").
        .manage(services::index::TagIndex::default())
        // Opaque bearer-token session map. See services::auth.
        .manage(services::auth::SessionStore::default())
        // Who is signed in to this instance — the session gate every
        // non-auth command checks first. See services::session.
        .manage(services::session::ActiveSession::default())
        // Per-username failed-login lockout. See services::session.
        .manage(services::session::LoginThrottle::default())
        // External file-change detection for the active vault
        // (`vault:changed` / `vault:watch-error`). See services::watcher
        // and vault/wiki/concurrency-safety.md ("External change
        // detection"). Started below for the configured vault and
        // restarted by the vault commands whenever the active vault
        // changes.
        .manage(services::watcher::VaultWatcher::default())
        // In-flight AI chat requests, so `ai_chat_stop` can abort one.
        // See services::llm.
        .manage(services::llm::ChatRequests::default())
        .setup(|app| {
            services::watcher::restart_for_active_vault(app.handle());
            // Auto backup to Drive / SFTP targets (services::backup).
            commands::backup::start_scheduler(app.handle().clone());
            Ok(())
        })
        // Every command except auth_login / auth_resume / auth_logout is
        // gated: the other auth_* commands resolve their bearer token,
        // everything else calls `require_session` first (enforced by
        // `tests::every_registered_command_is_gated`).
        .invoke_handler(tauri::generate_handler![
            commands::vault::vault_pick_folder,
            commands::vault::vault_init,
            commands::vault::vault_current,
            commands::vault::vault_set_active,
            commands::vault::vault_list_known,
            commands::vault::vault_create_default,
            commands::auth::auth_login,
            commands::auth::auth_resume,
            commands::auth::auth_logout,
            commands::auth::auth_change_password,
            commands::auth::auth_create_user,
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
            commands::notes::notes_version,
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
            commands::settings::app_config_set_ai_provider,
            commands::settings::app_config_set_appearance,
            commands::settings::app_config_set_clipping,
            commands::ai::ai_chat_send,
            commands::ai::ai_chat_stop,
            commands::ai::ai_infer_title,
            commands::ai::ai_list_models,
            commands::attachments::attachments_import,
            commands::attachments::attachments_import_bytes,
            commands::attachments::attachments_read_image,
            commands::evernote::evernote_import,
            commands::workspace::workspace_get,
            commands::workspace::workspace_set_last_opened,
            commands::calendar::calendar_list,
            commands::calendar::calendar_add,
            commands::calendar::calendar_update,
            commands::calendar::calendar_remove,
            commands::calendar::calendar_events,
            commands::calendar::calendar_refresh,
            commands::calendar::calendar_event_note,
            commands::backup::backup_targets_list,
            commands::backup::backup_drive_candidates,
            commands::backup::backup_target_add_drive,
            commands::backup::backup_target_add_sftp,
            commands::backup::backup_target_confirm_host_key,
            commands::backup::backup_target_update,
            commands::backup::backup_target_remove,
            commands::backup::backup_test,
            commands::backup::backup_run,
            commands::backup::backup_compare,
            commands::backup::backup_read_file,
            commands::backup::backup_restore_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_ids_route_to_menu_view_with_mode_payload() {
        for (mode, _, _) in VIEW_ITEMS {
            let id = format!("{VIEW_ID_PREFIX}{mode}");
            match route_menu_id(&id) {
                MenuRoute::View(payload) => assert_eq!(payload, *mode),
                _ => panic!("view id {id} did not route to menu:view"),
            }
        }
    }

    #[test]
    fn settings_id_routes_to_settings_channel() {
        assert!(matches!(
            route_menu_id(MENU_SETTINGS),
            MenuRoute::Unit("menu:settings")
        ));
    }

    #[test]
    fn known_action_ids_route_to_their_channels() {
        let cases = [
            (MENU_NEW_NOTE, "menu:new-note"),
            (MENU_NEW_FOLDER, "menu:new-folder"),
            (MENU_COMMAND_PALETTE, "menu:command-palette"),
            (MENU_AI_CHAT_SEND, "menu:ai-chat-send"),
            (MENU_AI_NEW_CHAT, "menu:ai-new-chat"),
            (MENU_AI_SELECT_MODEL, "menu:ai-select-model"),
            (MENU_AI_STOP, "menu:ai-stop"),
            (MENU_TOGGLE_EDIT, "menu:toggle-edit"),
            (MENU_IMPORT_EVERNOTE, "menu:import-evernote"),
        ];
        for (id, channel) in cases {
            match route_menu_id(id) {
                MenuRoute::Unit(c) => assert_eq!(c, channel),
                _ => panic!("{id} did not route to {channel}"),
            }
        }
    }

    #[test]
    fn settings_is_not_a_view_item() {
        // Settings moved out of the View menu into its own modal (Cmd+,).
        assert!(!VIEW_ITEMS.iter().any(|(mode, _, _)| *mode == "settings"));
    }

    #[test]
    fn unknown_id_is_ignored() {
        assert!(matches!(route_menu_id("bogus"), MenuRoute::None));
        // The removed AI Assist / AI Chat window items route nowhere.
        assert!(matches!(route_menu_id("toggle_ai"), MenuRoute::None));
        assert!(matches!(route_menu_id("ai_chat"), MenuRoute::None));
    }

    // ── session gate coverage ────────────────────────────────────────

    /// Commands reachable before sign-in. They authenticate (or end) a
    /// session themselves; nothing else may be listed here.
    const UNGATED: &[&str] = &["auth_login", "auth_resume", "auth_logout"];

    /// Auth commands gated by their bearer token instead of the active
    /// session: their body must resolve the token first.
    const TOKEN_GATED: &[&str] = &[
        "auth_change_password",
        "auth_create_user",
        "auth_list_users",
        "auth_set_user_active",
        "auth_list_audit_logs",
        "auth_log_action",
    ];

    fn command_source(module: &str) -> &'static str {
        match module {
            "ai" => include_str!("commands/ai.rs"),
            "attachments" => include_str!("commands/attachments.rs"),
            "auth" => include_str!("commands/auth.rs"),
            "backup" => include_str!("commands/backup.rs"),
            "calendar" => include_str!("commands/calendar.rs"),
            "evernote" => include_str!("commands/evernote.rs"),
            "journal" => include_str!("commands/journal.rs"),
            "notes" => include_str!("commands/notes.rs"),
            "search" => include_str!("commands/search.rs"),
            "settings" => include_str!("commands/settings.rs"),
            "sync" => include_str!("commands/sync.rs"),
            "tags" => include_str!("commands/tags.rs"),
            "vault" => include_str!("commands/vault.rs"),
            "workspace" => include_str!("commands/workspace.rs"),
            other => panic!("commands::{other} is not listed in command_source()"),
        }
    }

    /// `(module, fn)` for every entry of the `generate_handler!` list.
    fn registered_commands() -> Vec<(String, String)> {
        let src = include_str!("lib.rs");
        let start = src.find("generate_handler![").expect("handler list") + 18;
        let end = start + src[start..].find(']').expect("end of handler list");
        src[start..end]
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|entry| {
                let parts: Vec<&str> = entry.split("::").collect();
                assert_eq!(parts.len(), 3, "unexpected handler entry {entry}");
                assert_eq!(parts[0], "commands");
                (parts[1].to_string(), parts[2].to_string())
            })
            .collect()
    }

    /// The first statement of `fn name`'s body in `src`.
    fn first_statement(src: &str, name: &str) -> String {
        let decl = [format!("fn {name}("), format!("fn {name}<")]
            .iter()
            .find_map(|d| src.find(d.as_str()))
            .unwrap_or_else(|| panic!("fn {name} not found"));
        let body = decl + src[decl..].find('{').expect("fn body");
        src[body + 1..]
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with("//"))
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn every_registered_command_is_gated() {
        let registered = registered_commands();
        assert!(
            registered.len() > 50,
            "parsed {} commands",
            registered.len()
        );
        for (module, name) in &registered {
            if UNGATED.contains(&name.as_str()) {
                continue;
            }
            let first = first_statement(command_source(module), name);
            if TOKEN_GATED.contains(&name.as_str()) {
                assert!(
                    first.contains("sessions.resolve(&token)?;")
                        || first.contains("sessions.require_admin(&token)?;"),
                    "{module}::{name} must resolve its token first, starts with: {first}"
                );
            } else {
                assert!(
                    first == "require_session(&active)?;",
                    "{module}::{name} must call require_session(&active)? first, \
                     starts with: {first}"
                );
            }
        }
        // The exemption lists may only name real commands.
        for name in UNGATED.iter().chain(TOKEN_GATED) {
            assert!(
                registered.iter().any(|(_, n)| n == name),
                "{name} is exempt but not registered"
            );
        }
    }
}
