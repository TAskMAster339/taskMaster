# Linux и macOS: сборка и портирование

[Документация](README.md) · [Архитектура](ARCHITECTURE.md) · [Проверки](DEVELOPMENT.md#проверки)

## Текущий статус

| Платформа | Состояние проекта |
| --- | --- |
| Windows x64 | Windows CI и выпуск `.exe`/MSI |
| Fedora 45 x86-64 | RPM собран и установлен в контейнере Fedora. Запуск бинарника проверен в Plasma Wayland и вложенном Niri 26.04. Полная проверка интеграций требуется перед публикацией |
| Другие Linux | Экспериментальная сборка из исходников |
| macOS | Экспериментальная сборка из исходников; нативный запуск, подпись и упаковка не подтверждены CI |

Нативную проверку выполняйте в каждой целевой сессии по сценарию ниже.

## Общая подготовка

Нужны Git, Node.js 24 с npm и Rust stable с нативным toolchain целевой ОС. MSVC применяется только к Windows. `rusqlite` использует `bundled` SQLite; отдельный сервер базы не нужен. Системные библиотеки Tauri и загрузка npm/Cargo-зависимостей требуют сети при подготовке, работа установленного приложения остаётся локальной.

Собирайте и запускайте на целевой ОС. Добавление Rust target на Windows не устанавливает Linux/macOS SDK, WebView и средства упаковки. Для macOS используйте Mac; для Linux — Linux-среду с графической сессией для ручного запуска. WSL может помочь с Linux-сборкой, но не подтверждает поведение Windows и отдельного Linux desktop.

### Linux

Для Fedora 45 установите сборочные зависимости:

```bash
sudo dnf install gcc gcc-c++ make curl wget file pkgconf-pkg-config \
  webkit2gtk4.1-devel gtk3-devel openssl-devel libappindicator-gtk3-devel \
  librsvg2-devel libxdo-devel dbus-devel rpm-build
```

Для установки готового RPM из Assets релиза выполните `sudo dnf install ./taskMaster-fedora-x86_64.rpm` и откройте taskMaster из меню приложений. Для фоновой работы используйте «Настройки → Трей → Свернуть в трей». Трей должен быть доступен в Plasma или в Waybar. Повторный запуск из меню показывает основное окно. Закрытие основного окна скрывает его при доступном трее. Для полного выхода используйте меню трея. При недоступном трее закрытие окна завершает приложение.

#### Проверка подписи RPM из GitHub Releases

Скачайте RPM и `RPM-GPG-KEY-taskMaster.asc` из одного релиза. Проверьте полный отпечаток ключа через `gpg --show-keys --fingerprint RPM-GPG-KEY-taskMaster.asc` и сравните его с отпечатком, опубликованным сопровождающим по доверенному каналу. После совпадения выполните:

```bash
sudo rpm --import RPM-GPG-KEY-taskMaster.asc
rpm --define '_pkgverify_level signature' --checksig taskMaster-fedora-x86_64.rpm
sudo dnf --setopt=localpkg_gpgcheck=True install ./taskMaster-fedora-x86_64.rpm
```

#### Niri и Plasma Wayland

Показать или скрыть оверлей можно из приложения, меню трея или командой `taskmaster --toggle-overlay`. При первом запуске с этим аргументом откроются оба окна. В Plasma назначьте пользовательское сочетание на эту команду через системные настройки клавиатуры. В Niri добавьте сочетание в существующий блок `binds` и правило для окна:

```kdl
// Внутри binds
Ctrl+Alt+Space { spawn "taskmaster" "--toggle-overlay"; }

// На верхнем уровне
window-rule {
    match app-id="^taskmaster$" title="^taskMaster Overlay$"
    open-floating true
}
```

Через `niri msg pick-window` можно проверить, что установленный оверлей соответствует правилу. В локальной сборке на Niri 26.04 команда `niri msg windows` показала app-id `taskmaster`, заголовок `taskMaster Overlay` и плавающее состояние. Проверьте конфиг командой `niri validate`. В Wayland taskMaster передаёт размещение композитору. Для уведомлений в Niri запустите службу, реализующую `org.freedesktop.Notifications`. [Правила окон Niri](https://niri-wm.github.io/niri/Configuration%3A-Window-Rules.html)

В Plasma Wayland для удержания оверлея поверх обычных окон откройте **Параметры системы → Управление окнами → Правила окон**:

1. Откройте оверлей. Добавьте правило, нажмите «Определить свойства окна» и щёлкните по оверлею.
2. Оставьте определённый класс приложения и задайте точное совпадение заголовка `taskMaster Overlay`. Так правило будет действовать только на оверлей.
3. Добавьте свойство «Поверх других окон» (Keep above), выберите «Принудительно» (Force) и установите «Да». Примените правило и снова откройте оверлей.

Кнопка закрепления внутри оверлея блокирует перетаскивание и перестановку таймеров. Порядок окон определяет KWin. [Правила окон KWin](https://docs.kde.org/stable_kf6/en/kwin/kcontrol/windowspecific/window-matching0.html)


Для Ubuntu/Debian с WebKitGTK 4.1 подготовьте системные зависимости:

```bash
sudo apt update
sudo apt install build-essential curl wget file pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev
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

При проблемах запуска проверьте `npm run tauri -- info` и вывод терминала. Проверку окон, трея и уведомлений проводите в графической сессии. Ошибки инициализации трея и открытия оверлея на Fedora записываются в локальную диагностику.

## Данные и проверки

Пути получаются через Tauri, а не через Windows-переменные окружения. Подробное разделение SQLite, JSON и WebView-настроек описано в [архитектуре](ARCHITECTURE.md#хранилище-и-совместимость). На новой платформе проверьте создание и повторное открытие базы, миграции, Unicode в путях, копирование/восстановление и сохранение настроек.

Для экспериментов используйте одноразовый профиль ОС. Отдельный identifier через [CLI `--config`](https://v2.tauri.app/reference/cli/#dev) позволяет отделить пути Tauri: создайте вне репозитория JSON вида `{"identifier":"ru.taskmaster.porttest"}` и передайте его абсолютный путь через `npm run tauri -- dev --config /absolute/path/porttest.json`. Для проверок системных регистраций нужен отдельный профиль ОС. Автозапуск использует фиксированное имя `taskMaster` в Windows и Linux. Не проверяйте полный сброс и автозапуск в рабочем профиле.

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
| Fedora 45, RPM | `npm run tauri -- build --bundles rpm` | `src-tauri/target/release/bundle/rpm/` |
| Linux, Debian-пакет | `npm run tauri -- build --bundles deb` | `src-tauri/target/release/bundle/deb/` |
| Linux, AppImage | `npm run tauri -- build --bundles appimage` | `src-tauri/target/release/bundle/appimage/` |
| macOS, приложение | `npm run tauri -- build --bundles app` | `src-tauri/target/release/bundle/macos/` |
| macOS, образ установщика | `npm run tauri -- build --bundles dmg` | `src-tauri/target/release/bundle/dmg/` |

При явном `--target` или `CARGO_TARGET_DIR` путь отличается. Учитывайте [зависимости Debian](https://v2.tauri.app/distribute/debian/), [совместимость AppImage](https://v2.tauri.app/distribute/appimage/) и [настройки macOS bundle](https://v2.tauri.app/distribute/macos-application-bundle/). Для публичного распространения macOS отдельно настройте [подпись и notarization](https://v2.tauri.app/distribute/sign/macos/); локальный запуск не подтверждает готовность распространяемого пакета.

CI проверяет Windows и Fedora 45. Workflow публикации собирает Windows `.exe` и MSI и Fedora RPM, затем публикует их вместе. Перед ручным выпуском установите RPM в чистом профиле, проверьте запуск из меню, обновление пакета с сохранением данных и перечисленные выше сценарии в обеих сессиях. После публикации скачайте RPM из `latest` и повторите установку и запуск.
