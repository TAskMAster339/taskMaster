# taskMaster

Локальный минималистичный менеджер задач для Windows. Отображаемое имя приложения — `taskMaster`.

## Документация

- [Техническое задание](ТЗ.md)
- [Инструкции для AI-агентов](AGENTS.md)
- Проектные навыки Codex находятся в `.agents/skills/`: Tauri/Rust, UI, дизайн, TDD и desktop verification.

## Стек

Tauri 2, Rust, TypeScript без UI-фреймворка и SQLite. Данные хранятся локально; мобильная версия рассматривается после desktop MVP.

## Сборка и запуск в Windows

### Требования

- Windows 10 или новее.
- Node.js LTS (в комплекте npm).
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

## Статус

Реализованы создание и редактирование задач, ручная перестановка, выполнение и возврат в очередь, локальное SQLite-хранилище, автоматическая архивация через 24 часа, календарная история по дням, локальные напоминания, независимые сохраняемые таймеры с полноэкранным режимом и уведомлениями, системный трей и оверлей следующей задачи с перетаскиванием, закреплением и квадратными карточками таймеров с управлением.
