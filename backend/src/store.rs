//! Хранилище в JSON-файлах. Запись атомарная (временный файл и rename).

use serde::{de::DeserializeOwned, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};

pub struct Store {
    root: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Store { root: root.into(), lock: Mutex::new(()) }
    }

    /// Имя файла из произвольного id: оставляем буквы, цифры, `-` и `_`.
    pub fn safe_name(id: &str) -> String {
        id.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect()
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    pub fn exists(&self, rel: &str) -> bool {
        self.path(rel).is_file()
    }

    pub fn read<T: DeserializeOwned>(&self, rel: &str) -> Option<T> {
        let text = fs::read_to_string(self.path(rel)).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn write<T: Serialize>(&self, rel: &str, value: &T) -> Result<(), String> {
        let path = self.path(rel);
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("не удалось создать каталог: {e}"))?;
        }
        let tmp = path.with_extension("tmp");
        let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        fs::write(&tmp, text).map_err(|e| format!("не удалось записать файл: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("не удалось сохранить файл: {e}"))
    }

    /// Для цепочек чтение-изменение-запись. Внутри замыкания нельзя ждать (`await`).
    pub fn with_lock<R>(&self, f: impl FnOnce() -> R) -> R {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        f()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_removes_path_chars() {
        assert_eq!(Store::safe_name("p1-ru-001"), "p1-ru-001");
        assert_eq!(Store::safe_name("../x/y"), "___x_y");
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cqa_store_test_{}", std::process::id()));
        let store = Store::new(&dir);
        store.write("a/b.json", &vec![1, 2, 3]).unwrap();
        assert!(store.exists("a/b.json"));
        assert_eq!(store.read::<Vec<i32>>("a/b.json"), Some(vec![1, 2, 3]));
        assert_eq!(store.read::<Vec<i32>>("missing.json"), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
