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

Готовый исполняемый файл находится в `src-tauri\target\release\taskmaster.exe`. Скрипт собирает приложение без установщика. Команды Tauri напрямую также доступны: `npm run tauri -- dev`, `npm run tauri -- build --no-bundle`.

## Статус

Первая итерация реализует создание, редактирование, ручную перестановку и завершение задач с локальным SQLite-хранилищем. История, архивирование, таймер, напоминания и системный трей будут добавляться отдельными итерациями по ТЗ.
