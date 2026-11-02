use crate::app::error::AppError;
use crate::domain::models::Preferences;
use crate::persistence::store::TaskStore;
use rusqlite::params;

impl TaskStore {
    pub fn shortcuts(&self) -> Result<std::collections::BTreeMap<String, String>, AppError> {
        let mut result = crate::domain::shortcuts::defaults();
        let mut stmt = self
            .connection
            .prepare("SELECT action,combination FROM keyboard_shortcuts")
            .map_err(|_| AppError::storage())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| AppError::storage())?;
        for row in rows {
            let (action, key) = row.map_err(|_| AppError::storage())?;
            if result.contains_key(&action) {
                result.insert(action, key);
            }
        }
        Ok(result)
    }
    pub fn set_shortcut(
        &self,
        action: &str,
        combination: &str,
        overlay: &str,
    ) -> Result<std::collections::BTreeMap<String, String>, AppError> {
        let key = crate::domain::shortcuts::normalize(combination)?;
        let mut keys = self.shortcuts()?;
        if !keys.contains_key(action) {
            return Err(AppError::invalid_state());
        }
        keys.insert(action.into(), key.clone());
        crate::domain::shortcuts::validate(&keys, overlay)?;
        self.connection.execute("INSERT INTO keyboard_shortcuts(action,combination) VALUES(?1,?2) ON CONFLICT(action) DO UPDATE SET combination=excluded.combination",params![action,key]).map_err(|_|AppError::storage())?;
        Ok(keys)
    }
    pub fn preferences(&self) -> Result<Preferences, AppError> {
        self.connection
            .query_row(
                "SELECT reminder_minutes,archive_hours FROM preferences WHERE id=1",
                [],
                |row| {
                    Ok(Preferences {
                        reminder_minutes: row.get(0)?,
                        archive_hours: row.get(1)?,
                    })
                },
            )
            .map_err(|_| AppError::storage())
    }
    pub fn set_preferences(
        &self,
        reminder_minutes: i64,
        archive_hours: i64,
    ) -> Result<(), AppError> {
        if !(1..=1439).contains(&reminder_minutes) || !(1..=8760).contains(&archive_hours) {
            return Err(AppError { code: "invalid_preferences", message: "Укажите целые значения: напоминание от 1 до 1439 минут, архивация от 1 до 8760 часов.".into() });
        }
        self.connection
            .execute(
                "UPDATE preferences SET reminder_minutes=?1,archive_hours=?2 WHERE id=1",
                params![reminder_minutes, archive_hours],
            )
            .map_err(|_| AppError::storage())?;
        Ok(())
    }
    pub fn export_data(&self) -> Result<serde_json::Value, AppError> {
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(|_| AppError::storage())?;
        let mut data = serde_json::Map::new();
        for table in [
            "tasks",
            "task_events",
            "focus_sessions",
            "timers",
            "preferences",
            "keyboard_shortcuts",
            "deletion_undos",
        ] {
            let mut stmt = tx
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .map_err(|_| AppError::storage())?;
            let names: Vec<String> = stmt
                .column_names()
                .iter()
                .map(|name| (*name).to_owned())
                .collect();
            let rows = stmt
                .query_map([], |row| {
                    let mut object = serde_json::Map::new();
                    for (index, name) in names.iter().enumerate() {
                        use rusqlite::types::ValueRef;
                        let value = match row.get_ref(index)? {
                            ValueRef::Null => serde_json::Value::Null,
                            ValueRef::Integer(value) => serde_json::json!(value),
                            ValueRef::Real(value) => serde_json::json!(value),
                            ValueRef::Text(value) => serde_json::Value::String(
                                String::from_utf8_lossy(value).into_owned(),
                            ),
                            ValueRef::Blob(value) => serde_json::json!(value),
                        };
                        object.insert(name.clone(), value);
                    }
                    Ok(serde_json::Value::Object(object))
                })
                .map_err(|_| AppError::storage())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|_| AppError::storage())?;
            data.insert(table.into(), serde_json::json!(rows));
        }
        tx.commit().map_err(|_| AppError::storage())?;
        Ok(serde_json::Value::Object(data))
    }
}
