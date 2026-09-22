//! Language preference shared by the native menus and all webviews.
//! English source messages are keys in the same catalog the frontend uses.
use std::{collections::HashMap, sync::OnceLock};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

#[derive(Clone, Debug, Serialize)]
pub struct LocaleState {
    pub language: String,
    pub locale: String,
}

fn system_language() -> String {
    #[cfg(target_os = "macos")]
    {
        objc2_foundation::NSLocale::preferredLanguages()
            .firstObject().map(|s| s.to_string()).unwrap_or_else(|| "en".into())
    }
    #[cfg(not(target_os = "macos"))]
    { std::env::var("LANG").unwrap_or_else(|_| "en".into()) }
}

fn resolve<'a>(language: &'a str, system: &str) -> &'a str {
    match language {
        "en" | "zh-CN" => language,
        _ => {
            let system = system.to_ascii_lowercase();
            if system == "zh" || system.starts_with("zh-") || system.starts_with("zh_") { "zh-CN" } else { "en" }
        }
    }
}

#[tauri::command]
pub fn locale_get(app: AppHandle) -> LocaleState {
    let language = app.store(crate::settings::STORE).ok()
        .and_then(|s| s.get("language"))
        .and_then(|v| v.as_str().map(String::from))
        .filter(|s| matches!(s.as_str(), "system" | "en" | "zh-CN"))
        .unwrap_or_else(|| "system".into());
    let locale = resolve(&language, &system_language()).to_string();
    LocaleState { language, locale }
}

#[tauri::command]
pub fn locale_set(app: AppHandle, language: String) -> Result<LocaleState, String> {
    if !matches!(language.as_str(), "system" | "en" | "zh-CN") { return Err("Unsupported language".into()); }
    let store = app.store(crate::settings::STORE).map_err(|e| e.to_string())?;
    let old = store.get("language");
    store.set("language", serde_json::json!(language));
    if let Err(e) = store.save() {
        if let Some(value) = old { store.set("language", value); } else { store.delete("language"); }
        return Err(e.to_string());
    }
    let state = locale_get(app.clone());
    let settings = crate::settings::Settings::load(&app);
    let actions = app.state::<crate::actions::Registry>().all();
    crate::tray::set_actions(&app, &settings.hotkey, &actions);
    app.emit("locale:changed", &state).map_err(|e| e.to_string())?;
    Ok(state)
}

fn translate(locale: &str, message: &str) -> String {
    static CATALOG: OnceLock<HashMap<String, String>> = OnceLock::new();
    if locale != "zh-CN" { return message.to_string(); }
    CATALOG.get_or_init(|| serde_json::from_str(include_str!("../../src/locales/zh-CN.json")).expect("valid translation catalog"))
        .get(message).map(String::as_str).unwrap_or(message).to_string()
}

pub fn tr(app: &AppHandle, message: &str) -> String {
    translate(&locale_get(app.clone()).locale, message)
}

/// Replace placeholders in a single pass so inserted diagnostics are never interpreted.
pub fn format(app: &AppHandle, message: &str, values: &[&str]) -> String {
    interpolate(&tr(app, message), values)
}
fn interpolate(message: &str, values: &[&str]) -> String {
    let mut out = String::new();
    let mut rest = message;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        if let Some(end) = rest.find('}') {
            if let Ok(index) = rest[1..end].parse::<usize>() {
                if let Some(value) = values.get(index) {
                    out.push_str(value);
                    rest = &rest[end + 1..];
                    continue;
                }
            }
        }
        out.push('{');
        rest = &rest[1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn system_and_explicit_language() {
        for system in ["zh-Hans-CN", "zh-Hant-TW", "zh_CN", "ZH-cn", "zh"] { assert_eq!(resolve("system", system), "zh-CN"); }
        assert_eq!(resolve("system", "fr-FR"), "en");
        assert_eq!(resolve("en", "zh-CN"), "en");
        assert_eq!(resolve("zh-CN", "en-US"), "zh-CN");
    }
    #[test]
    fn native_catalog_and_literal_interpolation() {
        assert_eq!(translate("zh-CN", "Settings…"), "设置…");
        assert_eq!(translate("en", "Settings…"), "Settings…");
        assert_eq!(translate("zh-CN", "custom action"), "custom action");
        assert_eq!(interpolate("{0} / {1}", &["$& {1}", "value"]), "$& {1} / value");
    }
}
