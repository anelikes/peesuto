//! The menu-bar item: a template icon and a four-entry menu.

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager, Wry,
};

pub struct TrayHandles {
    history_item: MenuItem<Wry>,
}

fn history_label(hotkey: &str) -> String {
    format!("Show history  {}", crate::hotkeys::mac_symbols(hotkey))
}

pub fn build(app: &AppHandle, hotkey: &str) -> tauri::Result<()> {
    let history_item = MenuItemBuilder::with_id("history", history_label(hotkey)).build(app)?;
    let card_item = MenuItemBuilder::with_id("card", "Paste as card…").build(app)?;
    let settings_item = MenuItemBuilder::with_id("settings", "Settings…").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit Pocket Paste").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&history_item)
        .item(&card_item)
        .item(&settings_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let icon = Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Pocket Paste")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "history" => crate::windows::show_history(app),
            "card" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { crate::card::card_from_clipboard(app).await });
            }
            "settings" => crate::windows::show_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        // The positioner plugin learns where the tray icon is from these events.
        .on_tray_icon_event(|tray, event| tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event))
        .build(app)?;

    app.manage(TrayHandles { history_item });
    Ok(())
}

pub fn set_hotkey_label(app: &AppHandle, hotkey: &str) {
    if let Some(t) = app.try_state::<TrayHandles>() {
        let _ = t.history_item.set_text(history_label(hotkey));
    }
}
