mod commands;
mod domain;
mod services;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

const MENU_IMPORT_EVERNOTE: &str = "import_evernote";
const MENU_NEW_NOTE: &str = "new_note";
const MENU_NEW_FOLDER: &str = "new_folder";
const MENU_COMMAND_PALETTE: &str = "command_palette";
const MENU_TOGGLE_AI: &str = "toggle_ai";
const MENU_SETTINGS: &str = "settings";
const VIEW_ID_PREFIX: &str = "view:";

/// (id-suffix, label, accelerator) for the seven view-switch entries.
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
/// View menu that switches panels and toggles the palette / AI panel.
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

    let new_note = MenuItem::with_id(
        handle,
        MENU_NEW_NOTE,
        "New Note",
        true,
        Some("CmdOrCtrl+N"),
    )?;
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

    // View menu: the seven panels, then palette + AI toggle.
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
    let toggle_ai = MenuItem::with_id(
        handle,
        MENU_TOGGLE_AI,
        "Toggle AI Assist",
        true,
        Some("CmdOrCtrl+E"),
    )?;
    let separator = PredefinedMenuItem::separator(handle)?;
    let mut view_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        view_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<R>).collect();
    view_refs.push(&separator);
    view_refs.push(&command_palette);
    view_refs.push(&toggle_ai);
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
        MENU_TOGGLE_AI => MenuRoute::Unit("menu:toggle-ai"),
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
        .menu(build_menu)
        .on_menu_event(|app, event| {
            emit_menu_event(app, event.id().as_ref());
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
            commands::vault::vault_create_default,
            commands::auth::auth_login,
            commands::auth::auth_resume,
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
            (MENU_TOGGLE_AI, "menu:toggle-ai"),
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
    }
}
