# Архитектура и данные

[Документация](README.md) · [Добавление фичи](ADDING_FEATURES.md) · [Портирование](PORTING.md)

## Путь пользовательского действия

```text
DOM → feature/controller.ts → shared/tauri.ts → commands/*
                                                ↓
                                      app state / TaskStore
                                         ↓           ↓
                                      domain     persistence
                                                (SQLite)
```

Системные события идут через `app/` и `platform/`, затем через Tauri events обратно в WebView. У разных операций свои уведомления: обычные команды задач возвращают результат вызывающему frontend, а фоновые изменения и действия оверлея используют события. Новая команда не получает автоматическую синхронизацию окон только потому, что зарегистрирована в Tauri.

## Где искать код

Все пути ниже относительны корню репозитория.

| Изменение | Место и ответственность |
| --- | --- |
| Старт приложения и композиция UI | [frontend/src/main.ts](../frontend/src/main.ts), [app/bootstrap.ts](../frontend/src/app/bootstrap.ts), [app/configure.ts](../frontend/src/app/configure.ts) |
| Экран или действие пользователя | [frontend/src/features](../frontend/src/features): `controller.ts` и `state.ts` соответствующей фичи |
| Навигация и сборка экрана | [frontend/src/app](../frontend/src/app): `navigation.ts`, `view.ts`, `state.ts` |
| Типы ответа и IPC | [shared/types.ts](../frontend/src/shared/types.ts), [shared/tauri.ts](../frontend/src/shared/tauri.ts) |
| Тексты и оформление | [shared/messages.json](../frontend/src/shared/messages.json), [shared/i18n.ts](../frontend/src/shared/i18n.ts), [styles](../frontend/src/styles), [DESIGN.md](../DESIGN.md) |
| Регистрация плагинов и команд | [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) |
| Граница IPC | [commands](../src-tauri/src/commands): типизированные аргументы, получение состояния, вызов операции |
| Доменная модель и ограничения | [domain](../src-tauri/src/domain): модели, валидация, сочетания клавиш, настройки оверлея |
| Операции над SQLite | [persistence](../src-tauri/src/persistence): `TaskStore`, SQL, транзакции, миграции, копии |
| Запуск, фоновые проверки и lifecycle | [app](../src-tauri/src/app): `bootstrap.rs`, `runtime.rs`, `lifecycle.rs`, `state.rs` |
| Интеграция с ОС | [platform](../src-tauri/src/platform): окна, трей, уведомления, автозапуск, отображение, диагностика и сброс |

`domain/` не обращается к Tauri или SQLite. Значительная часть операций над задачами сегодня реализована методами `TaskStore` в `persistence/`; не ищите отдельный service layer, которого здесь нет. SQL остаётся в этом слое, повторно используемая чистая валидация — в доменном. Frontend-модули связываются явными callbacks через `configureFeatures`, а не новым глобальным диспетчером.

Файл `platform/windows.rs`, несмотря на имя, в основном содержит управление окнами через Tauri. Реальные Windows API также находятся в `platform/desktop.rs`, `platform/notifications.rs` и `commands/storage.rs`; карта переноса — в [PORTING.md](PORTING.md#места-для-адаптации).

## Контракт Tauri

Для примера проследите `create_task`: [Rust-команда](../src-tauri/src/commands/tasks.rs) → [операция хранилища](../src-tauri/src/persistence/tasks.rs) → [frontend-клиент](../frontend/src/shared/tauri.ts) → [контроллер задач](../frontend/src/features/tasks/controller.ts).

- Rust-функция помечается `#[tauri::command]` и регистрируется в `generate_handler!` в `lib.rs`. Самого объявления недостаточно.
- В `shared/tauri.ts` таблица `Commands` задаёт аргументы и результат `invoke`. Общие DTO находятся в `shared/types.ts`; их поля должны соответствовать сериализации Rust, включая `camelCase` и варианты enum. Типы пока поддерживаются вручную, генератора контрактов нет.
- Ошибка Rust — `AppError { code, message }` из [app/error.rs](../src-tauri/src/app/error.rs). На frontend используются `shared/errors.ts` и переводы backend-сообщений; ошибка сохранения не должна выглядеть как успех или стирать введённые данные.
- Подписки основного окна находятся в `app/bootstrap.ts`, оверлея — в `features/overlay/controller.ts`. Например, `tasks-changed` вызывает обновление задач, `database-restored` — перезагрузку WebView. При добавлении события проследите отправителя, все подписки и обработку ошибок; существующие имена не являются схемой для произвольных новых payload.
- Разрешения WebView описаны в [capabilities/default.json](../src-tauri/capabilities/default.json), CSP — в [tauri.conf.json](../src-tauri/tauri.conf.json). Вызов Rust-плагина из backend сам по себе не требует выдавать его JS API в WebView. Для нового Tauri API проверяйте официальные разрешения и поддержку ОС.

На Fedora `uses_linux_desktop` выбирает элементы настроек, `hide_to_tray` проверяет наличие иконки и хоста трея через D-Bus. Аргумент `--toggle-overlay` обрабатывается при запуске и передаётся текущему процессу через single-instance.

## Хранилище и совместимость

`AppState` содержит `Mutex<Result<TaskStore, AppError>>`. `with_store` получает блокировку и возвращает ошибку недоступного хранилища. Ошибка открытия базы сохраняется как состояние для восстановления; нельзя заменять её успешным пустым `TaskStore`. Длительные файловые операции выполняются через `spawn_blocking` там, где это уже предусмотрено командами хранения.

| Данные | Источник истины |
| --- | --- |
| Задачи, события, таймеры, параметры и локальные shortcuts | `taskmaster.sqlite3` в `app.path().app_data_dir()` |
| Язык и высокий контраст | `display-settings.json`, `platform/presentation.rs` |
| Позиция, закрепление и глобальное сочетание оверлея | `overlay-settings.json`, `persistence/overlay.rs` |
| Тема | WebView `localStorage`, `shared/theme.ts` |
| Автозапуск | Регистрация в ОС, `platform/desktop.rs` |
| Копии и диагностика | Подкаталоги `backups/` и `logs/` папки данных |

Не зашивайте системные пути: их определяет Tauri для ОС и identifier приложения. Разделение настроек важно для восстановления — SQLite-копия не заменяет все настройки. Полное правило описано в [BEHAVIOR.md](BEHAVIOR.md#резервные-копии-и-восстановление).

Текущая версия схемы задаётся `CURRENT_SCHEMA_VERSION` в [persistence/store.rs](../src-tauri/src/persistence/store.rs), миграции выполняет [persistence/schema.rs](../src-tauri/src/persistence/schema.rs) через `PRAGMA user_version`. Используются foreign keys и WAL. Таблицы: `tasks`, `task_events`, `timers`, `preferences`, `keyboard_shortcuts`, `deletion_undos`; `focus_sessions` сохранена для совместимости старых данных и не означает отдельную текущую фичу.

При изменении схемы добавляйте следующую миграцию с сохранением данных и обновляйте версию, не переписывая старые переходы под новую установку. Проверьте новую базу, обновление старой, повторное открытие, отказ на более новой/повреждённой схеме и восстановление копии. В [persistence/backups.rs](../src-tauri/src/persistence/backups.rs) есть собственная проверка совместимости: изменение схемы требует проверить и этот путь. Не копируйте работающий SQLite-файл вручную без учёта WAL — используйте механизм резервных копий.

## Время и lifecycle

Фоновые проверки находятся в `app/runtime.rs`; каждые пять секунд они обрабатывают архивирование, напоминания и завершение таймеров. Окно может быть скрыто в трей, процесс продолжает работать. Полный выход останавливает планировщик. Дополнительная проверка состояния при фокусе окна находится в `app/lifecycle.rs`.

Даты сохраняются как UTC Unix milliseconds; локальные границы дня вычисляются отдельно. Работающий таймер использует `Instant`, после перезапуска — сохранённую UTC-метку. Не заменяйте это ежесекундным decrement только на frontend: WebView может быть скрыт или замедлен. Для тестов используйте существующие методы с явным временем и временные базы.
