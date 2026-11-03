# Разработка taskMaster

[Документация](README.md) · [Архитектура](ARCHITECTURE.md) · [Добавление фичи](ADDING_FEATURES.md) · [Linux и macOS](PORTING.md)

## Стек

Tauri 2, Rust, TypeScript без UI-фреймворка и SQLite. Данные хранятся локально; мобильная версия рассматривается после desktop MVP.

## Быстрый старт

Команды выполняются из корня репозитория. Windows — текущая целевая платформа; подготовка Linux/macOS и известные ограничения описаны в [PORTING.md](PORTING.md).

```powershell
git clone https://github.com/TAskMAster339/taskMaster.git
cd taskMaster
npm ci
npm run tauri -- dev
```

Для обычной разработки используйте dev-режим: Rust собирается без release-оптимизаций, Vite обновляет интерфейс. Первая сборка загружает Cargo-зависимости и может занять заметно больше времени. Изменения `package-lock.json` требуют повторного `npm ci`; версии Rust-зависимостей закреплены в `src-tauri/Cargo.lock`.

`npm run dev` запускает только Vite на порту 1420. Обычный браузер не предоставляет Tauri IPC; для самостоятельной проверки UI используйте существующие [browser fixtures](../frontend/tests/fixtures/feature-check.html) с mocks. `npm run build` выполняет TypeScript-проверку и собирает frontend в `dist/`, но не создаёт desktop-приложение.

Входные точки, ответственность модулей, DTO и данные описаны в [ARCHITECTURE.md](ARCHITECTURE.md). Последовательность изменения кода — в [ADDING_FEATURES.md](ADDING_FEATURES.md).

## Сборка и запуск в Windows

### Требования

- Windows 10 или новее.
- Node.js 24 (в комплекте npm), как в CI.
- Rust с MSVC toolchain (`rustup default stable-msvc`) и Microsoft C++ Build Tools (MSVC).
- WebView2 Runtime.

### Самостоятельная release-сборка

Если нужен готовый executable вне dev-режима, из корня репозитория запустите PowerShell-скрипт:

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

Workflow [CI](../.github/workflows/ci.yml) запускается при push и pull request на Windows runner: Rust format/test/Clippy, frontend unit/browser-тесты с accessibility и production-сборка frontend. Ручной workflow [Publish Release](../.github/workflows/release.yml) доступен во вкладке **Actions** на default branch. Он повторно выполняет эти проверки, собирает `.exe` и MSI-установщик, прикладывает оба файла к release с версией и датой в теге и к release с тегом `latest`.

Перед запуском внесите заметные изменения в `CHANGELOG.md` в секцию `Unreleased`. После успешной публикации workflow открывает PR с переносом этих записей в секцию выпущенной версии и даты. История сохраняется, а `Unreleased` становится пустой после слияния PR. Проверьте и влейте этот PR перед следующим релизом. Если публикация завершается ошибкой, PR не создаётся и записи остаются для повторного запуска.

Для работы release workflow настройки репозитория должны разрешать `GITHUB_TOKEN` записывать contents и создавать pull request. Правила защиты тегов также должны разрешать workflow перемещать тег `latest`. Новый релиз блокируется, пока не влит PR архивации предыдущего changelog.

Каждый шаг с GitHub CLI получает `GH_TOKEN: ${{ github.token }}` через `env`, включая архивацию changelog ([аутентификация gh в Actions](https://cli.github.com/manual/gh_auth_login)). Если ошибка возникла на этом последнем шаге после публикации обоих релизов и отправки ветки `automation/archive-changelog-…`, откройте PR из уже созданной ветки в default branch по ссылке из лога, проверьте и влейте его. Повторная публикация для восстановления этого PR не нужна. Предупреждение Git о замене LF на CRLF не является причиной сбоя аутентификации.

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

Для отдельного debug-executable без dev-сервера: `npm run tauri -- build --debug --no-bundle`. Для повседневной интерактивной проверки достаточно `npm run tauri -- dev`; release-сборка нужна для упаковки или измерения release-производительности. При блокировке exe работающим приложением сначала завершить этот экземпляр. Для финальной упаковки: `npm run tauri -- build --bundles msi`.

`cargo test --locked --manifest-path src-tauri/Cargo.toml benchmark_queue_of_5000 -- --ignored --nocapture` измеряет операции на временной файловой базе из 5000 задач и удаляет её после проверки.

При запущенном Vite страница `/tests/performance/ui-check.html?count=5000` в обычном браузере проверяет настоящий frontend на Tauri mocks, не обращаясь к Rust или рабочей базе. В нативном WebView эта же страница использует настоящую БД: запускать только с заранее подготовленной одноразовой базой. Параметр `exercise=1` дополнительно проверяет перестановку, переименование и удаление с отменой; изменения разрешены только для набора из заданного количества задач с ID `fixture-N`. Проверочные страницы не входят в production-сборку.


## Если что-то не запускается

| Симптом | Что проверить |
| --- | --- |
| `npm.ps1` запрещён политикой PowerShell | Используйте `npm.cmd` вместо `npm` для той же команды; для проектного `.ps1` есть вариант запуска выше |
| Ошибка MSVC/linker или Windows SDK | Установлены ли C++ Build Tools и stable MSVC Rust; проверьте `rustup show` и `npm run tauri -- info` |
| Порт 1420 занят | Не запущен ли второй dev/Vite-процесс; остановите свой предыдущий экземпляр перед повторным запуском |
| Chromium для browser-тестов не найден | После `npm ci` выполните `npx playwright install chromium` |
| Открывается установленное окно вместо dev-сборки | Приложение single-instance; полностью завершите установленный экземпляр через трей, закрытие окна лишь скрывает его |
| База недоступна или восстановление прервано | Сохраните исходные файлы; используйте [восстановление](BEHAVIOR.md#резервные-копии-и-восстановление), не удаляйте базу ради запуска |
| На Linux нет WebKitGTK/pkg-config или не появляется окно | Сверьте системные зависимости и графическую сессию по [PORTING.md](PORTING.md) |
| TypeScript/сборка проходит, а системное действие не работает | Проверьте backend-ошибку и нативное поведение; на Linux/macOS часть действий пока возвращает Windows-specific ошибки |

Dev-сборка по умолчанию использует тот же identifier и данные, что установленное приложение. Для destructive-проверок нужен одноразовый профиль ОС; подробнее об изоляции в [PORTING.md](PORTING.md#данные-и-проверки). Не прикладывайте рабочую базу к issue. Обезличенные технические коды находятся в `logs/` папки данных; их формат и ограничения описаны в [BEHAVIOR.md](BEHAVIOR.md#диагностика).
