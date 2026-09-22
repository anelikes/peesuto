//! Secrets go to the macOS Keychain through the `keyring` crate, one generic
//! password item per name under the app identifier as the service. The
//! names are the ones `core/src/provider/config.ts` (`SECRET_REFS`) uses, so
//! `providers.json` can refer to them and the CLI finds the same items.

pub const SERVICE: &str = "com.peesuto.desktop";

fn entry(name: &str) -> Result<keyring::Entry, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/' | '.')) {
        return Err(format!("invalid secret name {name:?}"));
    }
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

pub fn get(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// An empty value deletes the item.
pub fn set(name: &str, value: &str) -> Result<(), String> {
    let e = entry(name)?;
    if value.is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        };
    }
    e.set_password(value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    get(&name)
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    set(&name, &value)
}
