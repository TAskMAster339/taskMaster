use crate::platform::diagnostics;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl AppError {
    pub(crate) fn invalid_reminder_time() -> Self {
        Self {
            code: "invalid_reminder_time",
            message: "Выберите время позже текущего.".into(),
        }
    }
    pub(crate) fn invalid_title() -> Self {
        Self {
            code: "invalid_title",
            message: "Введите название длиной от 1 до 300 символов.".into(),
        }
    }

    pub(crate) fn invalid_timer() -> Self {
        Self {
            code: "invalid_timer",
            message: "Укажите название и длительность от 1 секунды до 99 часов 59 минут 59 секунд."
                .into(),
        }
    }

    pub(crate) fn invalid_order() -> Self {
        Self {
            code: "invalid_order",
            message: "Не удалось сохранить порядок задач. Обновите список.".into(),
        }
    }

    pub(crate) fn invalid_state() -> Self {
        Self {
            code: "invalid_state",
            message: "Статус задачи уже изменился. Обновите список.".into(),
        }
    }

    pub(crate) fn storage() -> Self {
        diagnostics::record(diagnostics::Event::StorageError, Some("storage_error"));
        Self {
            code: "storage_error",
            message: "Не удалось открыть локальную базу данных.".into(),
        }
    }

    pub(crate) fn lock() -> Self {
        Self {
            code: "storage_error",
            message: "Хранилище задач временно недоступно.".into(),
        }
    }
}
