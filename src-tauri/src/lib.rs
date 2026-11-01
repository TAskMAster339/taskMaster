mod tasks;

use std::{
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use serde::Serialize;
use tasks::{HistoryDay, Task, TaskStore};
use tauri::{Manager, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppError {
    code: &'static str,
    message: String,
}

impl AppError {
    fn invalid_title() -> Self {
        Self {
            code: "invalid_title",
            message: "Введите название длиной от 1 до 300 символов.".into(),
        }
    }

    fn invalid_order() -> Self {
        Self {
            code: "invalid_order",
            message: "Не удалось сохранить порядок задач. Обновите список.".into(),
        }
    }

    fn invalid_state() -> Self {
        Self {
            code: "invalid_state",
            message: "Статус задачи уже изменился. Обновите список.".into(),
        }
    }

    fn storage() -> Self {
        Self {
            code: "storage_error",
            message: "Не удалось открыть локальную базу данных.".into(),
        }
    }

    fn lock() -> Self {
        Self {
            code: "storage_error",
            message: "Хранилище задач временно недоступно.".into(),
        }
    }
}

struct AppState {
    store: Mutex<Result<TaskStore, AppError>>,
}

fn with_store<T>(
    state: &AppState,
    action: impl FnOnce(&TaskStore) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let guard: MutexGuard<'_, Result<TaskStore, AppError>> =
        state.store.lock().map_err(|_| AppError::lock())?;
    action(guard.as_ref().map_err(Clone::clone)?)
}

#[tauri::command]
fn list_tasks(state: State<'_, AppState>) -> Result<Vec<Task>, AppError> {
    with_store(&state, TaskStore::list_tasks)
}

#[tauri::command]
fn create_task(title: String, state: State<'_, AppState>) -> Result<Task, AppError> {
    with_store(&state, |store| store.create_task(&title))
}

#[tauri::command]
fn rename_task(id: String, title: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.rename_task(&id, &title))
}

#[tauri::command]
fn reorder_tasks(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.reorder_tasks(&ids))
}

#[tauri::command]
fn complete_task(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.complete_task(&id))
}

#[tauri::command]
fn reopen_task(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.reopen_task(&id))
}

#[tauri::command]
fn archive_expired_tasks(state: State<'_, AppState>) -> Result<usize, AppError> {
    with_store(&state, |store| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        store.archive_expired_tasks(now)
    })
}

#[tauri::command]
fn list_history_for_range(
    start: i64,
    end: i64,
    state: State<'_, AppState>,
) -> Result<HistoryDay, AppError> {
    with_store(&state, |store| store.list_history_for_range(start, end))
}

#[tauri::command]
fn list_task_creation_times(
    start: i64,
    end: i64,
    state: State<'_, AppState>,
) -> Result<Vec<i64>, AppError> {
    with_store(&state, |store| store.list_task_creation_times(start, end))
}

#[tauri::command]
fn restore_task(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    with_store(&state, |store| store.restore_task(&id))
}

fn open_store(path: PathBuf) -> Result<TaskStore, AppError> {
    std::fs::create_dir_all(&path).map_err(|_| AppError::storage())?;
    let store =
        TaskStore::open(path.join("taskmaster.sqlite3")).map_err(|_| AppError::storage())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    store.archive_expired_tasks(now)?;
    Ok(store)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let store = app
                .path()
                .app_data_dir()
                .map_err(|_| AppError::storage())
                .and_then(open_store);
            app.manage(AppState {
                store: Mutex::new(store),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_tasks,
            create_task,
            rename_task,
            reorder_tasks,
            complete_task,
            reopen_task,
            archive_expired_tasks,
            list_history_for_range,
            list_task_creation_times,
            restore_task
        ])
        .run(tauri::generate_context!())
        .expect("failed to run taskMaster");
}

#[cfg(test)]
mod tests;
