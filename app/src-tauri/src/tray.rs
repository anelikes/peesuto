//! The menu-bar item: a template icon and a menu that lists the actions
//! Core knows (`trigger.menu`), rebuilt whenever the registry changes.

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Manager, Wry,
};

use crate::actions::{ActionSpec, RunOptions, Source};

const TRAY_ID: &str = "main";
const ACTION_PREFIX: &str = "action:";

pub fn build(app: &AppHandle, hotkey: &str) -> tauri::Result<()> {
    let icon = Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Pocket Paste")
        .menu(&menu(app, hotkey, &[])?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            match id {
                "history" => crate::windows::show_history(app),
                "settings" => crate::windows::show_settings(app),
                "quit" => app.exit(0),
                _ => {
                    if let Some(action) = id.strip_prefix(ACTION_PREFIX) {
                        let app = app.clone();
                        let action = action.to_string();
                        tauri::async_runtime::spawn(async move {
                            crate::actions::run(app, action, Source::Clipboard, RunOptions::default()).await;
                        });
                    }
                }
            }
        })
        // The positioner plugin learns where the tray icon is from these events.
        .on_tray_icon_event(|tray, event| tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event))
        .build(app)?;
    app.manage(tray);
    Ok(())
}

fn menu(app: &AppHandle, hotkey: &str, actions: &[ActionSpec]) -> tauri::Result<tauri::menu::Menu<Wry>> {
    let mut b = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("history", format!("Show history  {}", crate::hotkeys::mac_symbols(hotkey))).build(app)?)
        .separator();
    let mut any = false;
    for a in actions.iter().filter(|a| a.in_menu() && a.needs != "decider") {
        let label = match a.hotkey() {
            Some(h) => format!("{}  {}", a.name, crate::hotkeys::mac_symbols(h)),
            None => a.name.clone(),
        };
        b = b.item(&MenuItemBuilder::with_id(format!("{ACTION_PREFIX}{}", a.id), label).build(app)?);
        any = true;
    }
    if any {
        b = b.separator();
    }
    b.item(&MenuItemBuilder::with_id("settings", "Settings…").build(app)?)
        .item(&MenuItemBuilder::with_id("quit", "Quit Pocket Paste").build(app)?)
        .build()
}

/// Rebuild the menu from the registry (and the current history shortcut).
pub fn set_actions(app: &AppHandle, hotkey: &str, actions: &[ActionSpec]) {
    let Some(tray) = app.try_state::<TrayIcon<Wry>>() else { return };
    match menu(app, hotkey, actions) {
        Ok(m) => {
            if let Err(e) = tray.set_menu(Some(m)) {
                crate::log::line(format!("tray: could not set the menu: {e}"));
            }
        }
        Err(e) => crate::log::line(format!("tray: could not build the menu: {e}")),
    }
}
