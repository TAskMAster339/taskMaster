# Разработка taskMaster

[Главная страница](../README.md) · [Правила приложения](BEHAVIOR.md) · [Визуальная система](../DESIGN.md)

## Стек

Tauri 2, Rust, TypeScript без UI-фреймворка и SQLite. Данные хранятся локально; мобильная версия рассматривается после desktop MVP.

## Структура и границы модулей

```text
frontend/
  index.html, public/        HTML, локальные шрифты и текстуры
  src/
    app/                    запуск, композиция экранов, навигация и подписки
    features/               задачи, история, напоминания, таймеры, настройки, оверлей
    shared/                 DTO, типизированный IPC, локализация и DOM-функции
    styles/                 базовые стили, компоновка и компоненты
  tests/
    unit/                   Node unit-тесты
    browser/                браузерные сценарии и доступность
    fixtures/               HTML-стенд и Tauri mocks
    performance/            проверка списка из 5000 задач
src-tauri/src/
  app/                      состояние, запуск, lifecycle и планировщик
  commands/                 внешние типизированные Tauri-команды
  domain/                   модели, ограничения и правила без SQLite/Tauri
  persistence/              SQLite, миграции, операции и резервные копии
  platform/                 окна, трей, Windows API, диагностика и настройки отображения
  tests/                    отдельные файлы тестов и временных фикстур
scripts/
  Start-TaskMaster.ps1      сборка и запуск приложения целиком
```

Frontend-модули владеют своим состоянием; `app/configure.ts` связывает их явными callbacks. Все IPC-вызовы проходят через `shared/tauri.ts`, контракты данных находятся в `shared/types.ts`. Rust-команды вызывают прикладные операции и `TaskStore`; SQL и транзакции остаются в `persistence/`. `lib.rs` регистрирует плагины и команды, настройка приложения вынесена в `app/`. Приватные Rust-тесты подключаются через `#[cfg(test)]` к своим модулям, общие тесты хранилища — из корневого тестового модуля. Production API ради тестов не расширяется.

Корневые `package.json`, lockfile, Vite и TypeScript-конфигурации общие. Vite использует `frontend/` как root и собирает только приложение в корневой `dist/`; тестовые HTML-страницы в него не входят. UI-фреймворк, облако, аккаунты, аналитика и runtime-загрузка ресурсов из сети отсутствуют.

## Сборка и запуск в Windows

### Требования

- Windows 10 или новее.
- Node.js 24 (в комплекте npm), как в CI.
- Rust с MSVC toolchain (`rustup default stable-msvc`) и Microsoft C++ Build Tools (MSVC).
- WebView2 Runtime.

### Обычный запуск

Из корня репозитория запустите PowerShell-скрипт:

```powershell
.\scripts\Start-TaskMaster.ps1
```

Скрипт установит npm-зависимости командой `npm ci`, если папки `node_modules` ещё нет, соберёт интерфейс и Rust-приложение в release-режиме и запустит `taskmaster.exe`. При необходимости разрешите запуск локального `.ps1` в политике PowerShell для текущего процесса:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Start-TaskMaster.ps1
```

### Другие режимы

```powershell
# Режим разработки с Vite и автоматическим обновлением интерфейса
.\scripts\Start-TaskMaster.ps1 -Dev

# Только собрать приложение, не запускать его
.\scripts\Start-TaskMaster.ps1 -BuildOnly
```

Готовый исполняемый файл находится в `src-tauri\target\release\taskmaster.exe`. Скрипт собирает приложение без установщика. Для локальной сборки MSI используйте `npm run tauri -- build --bundles msi` (требуется Windows). Команды Tauri напрямую также доступны: `npm run tauri -- dev`, `npm run tauri -- build --no-bundle`.

## CI и релизы GitHub

Workflow `CI` запускается при push и pull request и выполняет Rust format/test/Clippy и production-сборку frontend на Windows runner. Ручной workflow `Publish Release` доступен во вкладке **Actions** на default branch. Он повторно выполняет эти проверки, собирает `.exe` и MSI-установщик, прикладывает оба файла к release с версией и датой в теге и к release с тегом `latest`.

Перед запуском внесите заметные изменения в `CHANGELOG.md` в секцию `Unreleased`. После успешной публикации workflow открывает PR с переносом этих записей в секцию выпущенной версии и даты. История сохраняется, а `Unreleased` становится пустой после слияния PR. Проверьте и влейте этот PR перед следующим релизом. Если публикация завершается ошибкой, PR не создаётся и записи остаются для повторного запуска.

Для работы release workflow настройки репозитория должны разрешать `GITHUB_TOKEN` записывать contents и создавать pull request. Правила защиты тегов также должны разрешать workflow перемещать тег `latest`. Новый релиз блокируется, пока не влит PR архивации предыдущего changelog.

## Проверки

Проверки из корня проекта: `npm test` — unit-тесты, `npm run test:browser` — браузерные сценарии и доступность, `npm run test:all` — оба набора. После `npm ci` установите браузер командой `npx playwright install chromium`. Браузерные тесты сами запускают временный Vite-сервер и закрывают его; рабочая SQLite-база не используется. Для сохранения снимков четырёх разделов в двух темах задайте `TASKMASTER_VISUAL_DIR` (путь к папке вне репозитория).

Обязательные проверки Rust и сборки:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run test:all
npm run build
```

Перед выпуском отдельно проверить нативную Windows-сборку: сохранение задач, порядка и таймеров после перезапуска; выполнение, архив и историю; напоминания и одноразовое завершение параллельных таймеров; резервную копию, восстановление и отказ на повреждённом файле; трей, оверлей и сочетания; темы, языки, фокус и прокрутку; MSI-установку и запуск. Автозапуск и полный сброс проверять только в изолированном Windows-профиле: изменение одного идентификатора Tauri не изолирует существующую запись автозапуска `taskMaster` в HKCU. Полный сброс должен удалить только одноразовые данные и перезапустить приложение; повторный запуск после ошибки очистки не создаёт пустую рабочую базу. Компиляция и браузерные mocks не подтверждают доставку Windows-уведомлений или работу установщика.

Обычная проверочная сборка: `npm run tauri -- build --debug --no-bundle`. При блокировке exe работающим приложением сначала завершить этот экземпляр. Для финальной упаковки: `npm run tauri -- build --bundles msi`.

`cargo test --locked --manifest-path src-tauri/Cargo.toml benchmark_queue_of_5000 -- --ignored --nocapture` измеряет операции на временной файловой базе из 5000 задач и удаляет её после проверки.

При запущенном Vite страница `/tests/performance/ui-check.html?count=5000` в обычном браузере проверяет настоящий frontend на Tauri mocks, не обращаясь к Rust или рабочей базе. В нативном WebView эта же страница использует настоящую БД: запускать только с заранее подготовленной одноразовой базой. Параметр `exercise=1` дополнительно проверяет перестановку, переименование и удаление с отменой; изменения разрешены только для набора из заданного количества задач с ID `fixture-N`. Проверочные страницы не входят в production-сборку.

