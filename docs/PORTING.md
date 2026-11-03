# Linux и macOS: сборка и портирование

[Документация](README.md) · [Архитектура](ARCHITECTURE.md) · [Проверки](DEVELOPMENT.md#проверки)

## Текущий статус

| Платформа | Состояние проекта |
| --- | --- |
| Windows x64 | Текущая целевая платформа; Windows CI и выпуск `.exe`/MSI |
| Linux | Экспериментальная сборка из исходников; нативный запуск и интеграции не подтверждены CI |
| macOS | Экспериментальная сборка из исходников; нативный запуск, подпись и упаковка не подтверждены CI |

Наличие кроссплатформенных Tauri и Rust не подтверждает готовность taskMaster на другой ОС. Ниже — инструкции подготовки и проверки переноса, а не обещание полной поддержки. Они сверены с текущим кодом и официальной документацией Tauri 3 ноября 2026 года; на Linux/macOS в рамках этой документационной итерации не выполнялись.

## Общая подготовка

Нужны Git, Node.js 24 с npm и Rust stable с нативным toolchain целевой ОС. MSVC применяется только к Windows. `rusqlite` использует `bundled` SQLite; отдельный сервер базы не нужен. Системные библиотеки Tauri и загрузка npm/Cargo-зависимостей требуют сети при подготовке, работа установленного приложения остаётся локальной.

Собирайте и запускайте на целевой ОС. Добавление Rust target на Windows не устанавливает Linux/macOS SDK, WebView и средства упаковки. Для macOS используйте Mac; для Linux — Linux-среду с графической сессией для ручного запуска. WSL может помочь с Linux-сборкой, но не подтверждает поведение Windows и отдельного Linux desktop.

### Linux

Для Ubuntu/Debian с WebKitGTK 4.1 подготовьте системные зависимости:

```bash
sudo apt update
sudo apt install build-essential curl wget file pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Для других дистрибутивов названия пакетов отличаются; используйте [официальные prerequisites Tauri](https://v2.tauri.app/start/prerequisites/#linux). Не подменяйте WebKitGTK 4.1 пакетами 4.0 при ошибке поиска библиотеки. Версию дистрибутива и системных библиотек включайте в отчёт о переносе.

### macOS

Для desktop-разработки установите Xcode Command Line Tools:

```bash
xcode-select --install
```

Для разработки только desktop Tauri допускает Command Line Tools вместо полного Xcode; см. [prerequisites macOS](https://v2.tauri.app/start/prerequisites/#macos). Используйте Rust для архитектуры машины. Сборки Apple Silicon и Intel проверяются отдельно; universal bundle требует обоих targets и отдельной проверки.

## Первый запуск из исходников

Из терминала целевой ОС:

```bash
git clone https://github.com/TAskMAster339/taskMaster.git
cd taskMaster
npm ci
npm run tauri -- info
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- dev
```

PowerShell-скрипт `Start-TaskMaster.ps1` рассчитан на Windows и `.exe`; на Linux/macOS используйте npm/Tauri CLI напрямую. `tauri dev` сам запускает Vite через `beforeDevCommand`. `npm run build` собирает только frontend; успешный результат не проверяет Rust или WebView целевой ОС.

Сохраните первый реальный сбой и найдите его источник по таблице ниже. Не удаляйте Windows-ветки, проверки целостности или восстановление базы ради прохождения компиляции. Без графической сессии можно проверять часть сборки/тестов, но не tray, окна и системные уведомления. Если Tauri завершится из-за tray, изучите инициализацию в `app/bootstrap.rs` и `platform/tray.rs`: сейчас её ошибка может прервать запуск целиком.

## Места для адаптации

Это карта существующего кода и работы для порта. Предлагаемые адаптеры ещё не реализованы.

| Область и исходник | Текущее ограничение | Что сделать и проверить при переносе |
| --- | --- | --- |
| [platform/desktop.rs](../src-tauri/src/platform/desktop.rs): `open_about_link` | Windows `ShellExecuteW`, на других ОС ошибка | Открытие только разрешённых HTTPS-ссылок через подходящий системный механизм; сохранить allowlist |
| [commands/storage.rs](../src-tauri/src/commands/storage.rs): `open_data_directory` | `explorer.exe`, вне Windows явная ошибка | Открытие фактической папки данных через Finder/файловый менеджер, пути с пробелами и Unicode |
| [platform/notifications.rs](../src-tauri/src/platform/notifications.rs) | WinRT-статус и `ms-settings:notifications`; вне Windows статус unknown, открытие настроек возвращает ошибку | Нативная проверка/представление разрешений, честные состояния UI, доставка и обработка клика; путь отправки через Tauri-плагин уже существует |
| [platform/desktop.rs](../src-tauri/src/platform/desktop.rs), [platform/reset.rs](../src-tauri/src/platform/reset.rs) | Windows registry-часть автозапуска защищена `cfg`, плагин используется и вне Windows | Проверить регистрацию, повторный запуск и отключение при полном сбросе на каждой ОС, исправить Windows-specific сообщения |
| [platform/tray.rs](../src-tauri/src/platform/tray.rs), [app/lifecycle.rs](../src-tauri/src/app/lifecycle.rs) | Закрытие основного окна скрывает его; интерфейс возврата зависит от трея | Проверить возврат к окну, явный выход, single-instance и поведение без доступного трея |
| [platform/windows.rs](../src-tauri/src/platform/windows.rs) | Общие Tauri-окна, topmost и размещение проверялись для Windows | Несколько мониторов, DPI, рабочие области, закрепление, таймеры и полноэкранный режим; на Linux отдельно X11/Wayland |
| [lib.rs](../src-tauri/src/lib.rs), [commands/overlay.rs](../src-tauri/src/commands/overlay.rs) | Глобальная клавиша через plugin, `Ctrl+Alt+Space` по умолчанию | Регистрация и конфликт с системными shortcuts; не обещать одинаковую работу во всех desktop environments |
| [tauri.conf.json](../src-tauri/tauri.conf.json), [capabilities](../src-tauri/capabilities) | Общая конфигурация, разрешения двух окон, Windows release workflow | При необходимости платформенные overrides и минимальные разрешения; отдельная упаковка и CI целевой ОС |

Платформенные ветки держите в Rust `platform/` с явными `cfg`, сохраняя небольшие команды и существующие DTO. Сначала проверьте API закреплённых версий плагинов в Cargo.lock и их актуальную [официальную документацию](https://v2.tauri.app/plugin/). Общие доменные правила не должны получать условные Windows/Linux/macOS варианты только из-за замены механизма уведомления.

Трей имеет [платформенные ограничения](https://v2.tauri.app/learn/system-tray/), в частности Linux не поддерживает tray click events так же, как Windows. Для глобальных сочетаний проверяйте [документацию плагина](https://v2.tauri.app/plugin/global-shortcut/) и поведение в выбранной сессии. UI не должен сообщать об успехе неподдерживаемой команды; решите в конкретном PR, будет действие адаптировано или показано как недоступное.

## Данные и проверки

Пути получаются через Tauri, а не через Windows-переменные окружения. Подробное разделение SQLite, JSON и WebView-настроек описано в [архитектуре](ARCHITECTURE.md#хранилище-и-совместимость). На новой платформе проверьте создание и повторное открытие базы, миграции, Unicode в путях, копирование/восстановление и сохранение настроек.

Для экспериментов используйте одноразовый профиль ОС. Отдельный identifier через [CLI `--config`](https://v2.tauri.app/reference/cli/#dev) позволяет отделить пути Tauri: создайте вне репозитория JSON вида `{"identifier":"ru.taskmaster.porttest"}` и передайте его абсолютный путь через `npm run tauri -- dev --config /absolute/path/porttest.json`. Это не полная изоляция системных регистраций: Windows-автозапуск использует фиксированное имя `taskMaster`. Не проверяйте полный сброс и автозапуск в рабочем профиле.

После успешной компиляции и запуска пройдите:

- Создание, переименование, перестановку, выполнение, архив и историю; перезапуск с сохранением данных.
- Напоминание и завершение параллельных таймеров при открытом окне и в трее; отсутствие повторного уведомления. Полный выход не должен обещать доставку напоминаний.
- Оверлей, несколько мониторов, глобальные сочетания и конфликты; доступность меню/выхода при проблеме трея.
- Светлую/тёмную тему, три языка, клавиатуру, фокус, системный масштаб; WebKitGTK/WKWebView могут отображать CSS иначе, чем WebView2.
- Копию, восстановление, отказ на повреждённом файле; в одноразовом профиле — автозапуск и полный сброс.

Команды format/test/Clippy и browser-тестов общие и приведены в [DEVELOPMENT.md](DEVELOPMENT.md#проверки). Для Playwright на Linux могут понадобиться системные зависимости: `npx playwright install --with-deps chromium`. Тестовый Chromium проверяет DOM на mocks, но не заменяет проверку нативного WebKit.

## Упаковка после адаптации

Сначала получите рабочую debug-сборку и устраните платформенные ограничения. Для отдельного executable без упаковки используйте `npm run tauri -- build --debug --no-bundle`. Дальше на целевой ОС:

| ОС | Пример команды | Каталог результата при стандартном Cargo target dir |
| --- | --- | --- |
| Linux, Debian-пакет | `npm run tauri -- build --bundles deb` | `src-tauri/target/release/bundle/deb/` |
| Linux, AppImage | `npm run tauri -- build --bundles appimage` | `src-tauri/target/release/bundle/appimage/` |
| macOS, приложение | `npm run tauri -- build --bundles app` | `src-tauri/target/release/bundle/macos/` |
| macOS, образ установщика | `npm run tauri -- build --bundles dmg` | `src-tauri/target/release/bundle/dmg/` |

При явном `--target` или `CARGO_TARGET_DIR` путь отличается. Учитывайте [зависимости Debian](https://v2.tauri.app/distribute/debian/), [совместимость AppImage](https://v2.tauri.app/distribute/appimage/) и [настройки macOS bundle](https://v2.tauri.app/distribute/macos-application-bundle/). Для публичного распространения macOS отдельно настройте [подпись и notarization](https://v2.tauri.app/distribute/sign/macos/); локальный запуск не подтверждает готовность распространяемого пакета.

Текущие `.github/workflows/ci.yml` и `release.yml` рассчитаны на Windows. Добавление Linux/macOS runner, системных зависимостей, упаковки и публикации — часть отдельного PR о поддержке платформы. Этот документ сам по себе не меняет релизы. В таком PR укажите ОС/архитектуру, desktop session для Linux, версии toolchain, точные команды и результаты, проверенные интеграции и оставшиеся ограничения; затем обновите таблицу статуса в начале страницы.
