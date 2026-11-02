import { getCurrentWindow } from "@tauri-apps/api/window";
import { appState } from "../../app/state.ts";
import { announce, escapeHtml, root, skipLink } from "../../shared/dom.ts";
import { backendMessage } from "../../shared/errors.ts";
import { backendText, language, languageNames, languages, setLanguage, t, type Language } from "../../shared/i18n.ts";
import { displayShortcut, keyboardCombination, shortcutLabels, type ShortcutAction } from "../../shared/shortcuts.ts";
import { invoke } from "../../shared/tauri.ts";
import { themeLabels, themeOrder, themeStorageKey } from "../../shared/theme.ts";
import { type ClearMode, type DisplaySettings, type Theme } from "../../shared/types.ts";
import { taskAnimationLocks } from "../tasks/controller.ts";
import { tasksState } from "../tasks/state.ts";
import { timersState } from "../timers/state.ts";
import { settingsState } from "./state.ts";
export function updateAutostartControls(): void {
    const checkbox = root.querySelector<HTMLInputElement>("[data-autostart]");
    if (checkbox) {
        checkbox.checked = settingsState.autostartEnabled === true;
        checkbox.disabled = settingsState.autostartBusy || settingsState.autostartEnabled === null;
    }
    const status = root.querySelector<HTMLElement>("[data-autostart-status]");
    if (status)
        status.textContent = settingsState.autostartMessage;
    const retry = root.querySelector<HTMLButtonElement>("[data-autostart-retry]");
    if (retry) {
        retry.hidden = settingsState.autostartEnabled !== null;
        retry.disabled = settingsState.autostartBusy;
    }
}
export async function refreshAutostart(): Promise<void> {
    if (settingsState.autostartBusy)
        return;
    settingsState.autostartBusy = true;
    updateAutostartControls();
    try {
        settingsState.autostartEnabled = await invoke("get_autostart_enabled");
        settingsState.autostartMessage = "";
    }
    catch (error) {
        settingsState.autostartEnabled = null;
        settingsState.autostartMessage = backendMessage(error);
    }
    finally {
        settingsState.autostartBusy = false;
        updateAutostartControls();
    }
}
export function renderAutostartSettings(): string {
    return `<section class="settings-section" aria-labelledby="startup-heading"><h2 id="startup-heading">${t("Запуск")}</h2>
    <label class="settings-check"><input type="checkbox" data-autostart ${settingsState.autostartEnabled ? "checked" : ""} ${settingsState.autostartBusy || settingsState.autostartEnabled === null ? "disabled" : ""}/><span>${t("Запускать с Windows")}</span></label>
    <p role="status" data-autostart-status>${escapeHtml(settingsState.autostartMessage)}</p>
    <button class="retry-button" type="button" data-autostart-retry ${settingsState.autostartEnabled === null ? "" : "hidden"}>${t("Повторить проверку")}</button>
  </section>`;
}
export function bindAutostartSettings(): void {
    root.querySelector<HTMLButtonElement>("[data-autostart-retry]")?.addEventListener("click", () => { void refreshAutostart(); });
    root.querySelector<HTMLInputElement>("[data-autostart]")?.addEventListener("change", async (event) => {
        const desired = (event.currentTarget as HTMLInputElement).checked;
        if (settingsState.autostartBusy) {
            updateAutostartControls();
            return;
        }
        settingsState.autostartBusy = true;
        updateAutostartControls();
        try {
            settingsState.autostartEnabled = await invoke("set_autostart_enabled", { enabled: desired });
            settingsState.autostartMessage = t("Сохранено");
        }
        catch (error) {
            settingsState.autostartMessage = backendMessage(error);
            try {
                settingsState.autostartEnabled = await invoke("get_autostart_enabled");
            }
            catch {
                settingsState.autostartEnabled = null;
            }
        }
        finally {
            settingsState.autostartBusy = false;
            updateAutostartControls();
        }
    });
}
export function updateNotificationControls(): void {
    const status = root.querySelector<HTMLElement>("[data-notification-permission]");
    if (status) {
        status.textContent = backendText(settingsState.notificationStatus?.message ?? (settingsState.notificationReadError || t("Проверка состояния…")));
        status.classList.toggle("is-blocked", settingsState.notificationStatus !== null && !settingsState.notificationStatus.canTest);
    }
    const hint = root.querySelector<HTMLElement>("[data-notification-identity]");
    if (hint)
        hint.hidden = !settingsState.notificationStatus?.usesSystemIdentity;
    const message = root.querySelector<HTMLElement>("[data-notification-result]");
    if (message)
        message.textContent = settingsState.notificationActionMessage;
    root.querySelectorAll<HTMLButtonElement>("[data-notification-test], [data-notification-refresh]").forEach((button) => { button.disabled = settingsState.notificationBusy || (button.hasAttribute("data-notification-test") && !settingsState.notificationStatus?.canTest); });
    const warning = document.querySelector<HTMLElement>("[data-reminder-notification-warning]");
    if (warning) {
        warning.hidden = settingsState.notificationStatus === null || settingsState.notificationStatus.canTest;
        warning.querySelector<HTMLElement>("p")!.textContent = backendText(settingsState.notificationStatus?.message ?? "");
    }
}
export async function refreshNotificationStatus(): Promise<void> {
    if (settingsState.notificationBusy)
        return;
    settingsState.notificationBusy = true;
    updateNotificationControls();
    try {
        settingsState.notificationStatus = await invoke("get_notification_status");
        settingsState.notificationReadError = "";
    }
    catch (error) {
        settingsState.notificationStatus = null;
        settingsState.notificationReadError = backendMessage(error);
    }
    finally {
        settingsState.notificationBusy = false;
        updateNotificationControls();
    }
}
export function renderNotificationSettings(): string {
    return `<section class="settings-section" aria-labelledby="notifications-heading"><h2 id="notifications-heading">${t("Уведомления")}</h2>
    <p data-notification-permission role="status" class="${settingsState.notificationStatus !== null && !settingsState.notificationStatus.canTest ? "is-blocked" : ""}">${escapeHtml(backendText(settingsState.notificationStatus?.message ?? (settingsState.notificationReadError || t("Проверка состояния…"))))}</p>
    <p>${t("Напоминания работают, пока taskMaster запущен, в том числе в трее.")}</p>
    <p data-notification-identity ${settingsState.notificationStatus?.usesSystemIdentity ? "" : "hidden"}>${t("В этой сборке отправитель — Windows PowerShell.")}</p>
    <div class="settings-actions"><button class="retry-button" type="button" data-notification-test ${settingsState.notificationBusy || !settingsState.notificationStatus?.canTest ? "disabled" : ""}>${t("Проверить уведомление")}</button>
    <button class="retry-button" type="button" data-notification-refresh ${settingsState.notificationBusy ? "disabled" : ""}>${t("Обновить состояние")}</button>
    <button class="retry-button" type="button" data-open-notification-settings>${t("Настройки Windows")}</button></div>
    <p role="status" data-notification-result>${escapeHtml(settingsState.notificationActionMessage)}</p>
  </section>`;
}
export function bindNotificationControls(scope: ParentNode = root): void {
    scope.querySelectorAll<HTMLButtonElement>("[data-open-notification-settings]").forEach((button) => button.addEventListener("click", async () => {
        try {
            await invoke("open_notification_settings");
        }
        catch (error) {
            settingsState.notificationActionMessage = backendMessage(error);
            tasksState.errorMessage = settingsState.notificationActionMessage;
            if (appState.activeView === "settings")
                updateNotificationControls();
            else
                effects.render(true);
        }
    }));
    scope.querySelector<HTMLButtonElement>("[data-notification-refresh]")?.addEventListener("click", () => { void refreshNotificationStatus(); });
    scope.querySelector<HTMLButtonElement>("[data-notification-test]")?.addEventListener("click", async () => {
        if (settingsState.notificationBusy)
            return;
        settingsState.notificationBusy = true;
        settingsState.notificationActionMessage = t("Отправка…");
        updateNotificationControls();
        try {
            await invoke("send_test_notification");
            settingsState.notificationActionMessage = t("Тестовое уведомление отправлено.");
        }
        catch (error) {
            settingsState.notificationActionMessage = backendMessage(error);
        }
        finally {
            settingsState.notificationBusy = false;
            updateNotificationControls();
            void refreshNotificationStatus();
        }
    });
}
export async function refreshBackupStatus(): Promise<void> {
    try {
        settingsState.backupStatus = await invoke("get_backup_status");
    }
    catch (error) {
        settingsState.backupMessage = backendMessage(error);
    }
    if (appState.activeView === "settings")
        effects.render(true);
}
export function applyTheme(): void {
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = settingsState.theme === "system" ? (systemDark ? "dark" : "light") : settingsState.theme;
    document.documentElement.dataset.themeMode = settingsState.theme;
    document.documentElement.dataset.contrast = settingsState.displaySettings.highContrast ? "high" : "normal";
}
export function renderBackupSettings(): string {
    return `<section class="settings-section" aria-labelledby="backup-heading"><h2 id="backup-heading">${t("Резервные копии")}</h2>
    <p>${t("Ежедневные копии создаются при запуске. Хранятся последние семь.")}</p>
    ${settingsState.backupStatus?.warning ? `<p class="backup-warning" role="alert">${escapeHtml(backendText(settingsState.backupStatus.warning))}</p>` : ""}
    <div class="backup-actions">
      <button class="retry-button" type="button" data-backup-action="create" ${settingsState.backupBusy || !settingsState.backupStatus?.databaseAvailable ? "disabled" : ""}>${t("Создать резервную копию")}</button>
      <button class="retry-button" type="button" data-backup-action="choose" ${settingsState.backupBusy || !settingsState.backupStatus ? "disabled" : ""}>${t("Восстановить из файла")}</button>
      <button class="retry-button" type="button" data-backup-action="latest" ${settingsState.backupBusy || !settingsState.backupStatus?.hasDailyCopy ? "disabled" : ""}>${t("Восстановить последнюю ежедневную")}</button>
      <button class="retry-button" type="button" data-backup-action="folder" ${settingsState.backupBusy || !settingsState.backupStatus ? "disabled" : ""}>${t("Открыть папку данных")}</button>
    </div><p role="status" aria-live="polite">${escapeHtml(settingsState.backupMessage)}</p>
    ${settingsState.restorePreview ? `<dialog class="reminder-dialog backup-confirm" data-restore-dialog aria-labelledby="restore-heading"><form data-restore-confirm><h2 id="restore-heading">${t("Восстановить данные?")}</h2>
      <p class="backup-source">${escapeHtml(settingsState.restorePreview.source)}</p>
      <dl class="backup-summary"><dt>${t("Задачи")}</dt><dd>${settingsState.restorePreview.tasks}</dd><dt>${t("События истории")}</dt><dd>${settingsState.restorePreview.events}</dd><dt>${t("Таймеры")}</dt><dd>${settingsState.restorePreview.timers}</dd></dl>
      <p>${t("Текущие задачи, история, таймеры и настройки задач будут заменены. Перед заменой текущие данные будут сохранены отдельно.")}</p>
      <div class="reminder-actions"><button type="button" data-cancel-restore ${settingsState.backupBusy ? "disabled" : ""}>${t("Отмена")}</button><button type="submit" ${settingsState.backupBusy ? "disabled" : ""}>${settingsState.backupBusy ? t("Восстановление…") : t("Восстановить")}</button></div>
    </form></dialog>` : ""}
  </section>`;
}
export function bindBackupSettings(): void {
    root.querySelectorAll<HTMLButtonElement>("[data-backup-action]").forEach((button) => button.addEventListener("click", async () => {
        if (settingsState.backupBusy)
            return;
        const action = button.dataset.backupAction;
        settingsState.backupBusy = true;
        settingsState.backupMessage = action === "create" ? t("Создание копии…") : action === "folder" ? "" : t("Проверка копии…");
        effects.render(true);
        try {
            if (action === "folder") {
                await invoke("open_data_directory");
            }
            else if (action === "create") {
                const path = await invoke("create_database_backup");
                settingsState.backupMessage = path ? `${t("Копия сохранена:")} ${path}` : "";
            }
            else {
                settingsState.restorePreview = await invoke("prepare_database_restore", { latest: action === "latest" });
                settingsState.backupMessage = "";
            }
        }
        catch (error) {
            settingsState.backupMessage = backendMessage(error);
        }
        finally {
            settingsState.backupBusy = false;
            effects.render(true);
        }
    }));
    const cancel = (): void => { if (settingsState.backupBusy)
        return; settingsState.restorePreview = null; void invoke("cancel_database_restore").catch((error) => { settingsState.backupMessage = backendMessage(error); effects.render(true); }); effects.render(true); };
    root.querySelector<HTMLButtonElement>("[data-cancel-restore]")?.addEventListener("click", cancel);
    const dialog = root.querySelector<HTMLDialogElement>("[data-restore-dialog]");
    dialog?.addEventListener("cancel", (event) => { event.preventDefault(); cancel(); });
    root.querySelector<HTMLFormElement>("[data-restore-confirm]")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!settingsState.restorePreview || settingsState.backupBusy)
            return;
        const token = settingsState.restorePreview.token;
        settingsState.backupBusy = true;
        settingsState.backupMessage = t("Восстановление…");
        effects.render(true);
        let restoredPath: string | null = null;
        try {
            const path = await invoke("confirm_database_restore", { token });
            restoredPath = path;
            settingsState.restorePreview = null;
            tasksState.editingTaskId = null;
            timersState.fullscreenTimerId = null;
            taskAnimationLocks.clear();
            settingsState.preferences = await invoke("get_preferences");
            settingsState.preferencesReady = true;
            await Promise.all([effects.refreshTasks(), effects.refreshTimers(false), loadShortcuts(), effects.refreshDeletionUndos()]);
            const overlayStatus = await invoke("get_overlay_shortcut_status");
            settingsState.overlayShortcut = overlayStatus.shortcut;
            settingsState.overlayShortcutAvailable = overlayStatus.available;
            settingsState.backupMessage = `${t("Данные восстановлены. Предыдущие данные сохранены:")} ${path}`;
            await refreshBackupStatus();
        }
        catch (error) {
            settingsState.restorePreview = null;
            settingsState.backupMessage = restoredPath ? `${t("Данные восстановлены, но интерфейс не удалось обновить. Перезапустите приложение. Предыдущие данные:")} ${restoredPath}` : backendMessage(error);
        }
        finally {
            settingsState.backupBusy = false;
            effects.render(true);
        }
    });
    if (dialog && !dialog.open)
        dialog.showModal();
}
export function renderSettings(): void {
    const previousScrollTop = root.querySelector<HTMLElement>(".settings-view")?.scrollTop ?? 0;
    root.innerHTML = `<div class="app-shell">${effects.renderSidebar()}
  <main id="settings" class="main-content settings-view"><h1>${t("Настройки")}<span class="heading-period">.</span></h1>
    <section class="settings-section" aria-labelledby="theme-heading"><h2 id="theme-heading">${t("Оформление")}</h2><label for="settings-theme">${t("Тема")}</label>
    <select id="settings-theme" data-theme-select>${themeOrder.map((value) => `<option value="${value}" ${settingsState.theme === value ? "selected" : ""}>${themeLabels[value]}</option>`).join("")}</select>
    <label for="settings-language">${t("Язык")}</label><select id="settings-language" data-language-select ${settingsState.displaySettingsReady ? "" : "disabled"}>${languages.map((value) => `<option value="${value}" ${language() === value ? "selected" : ""}>${languageNames[value]}</option>`).join("")}</select>
    <label class="settings-check"><input id="settings-contrast" type="checkbox" data-high-contrast ${settingsState.displaySettings.highContrast ? "checked" : ""} ${settingsState.displaySettingsReady ? "" : "disabled"}/><span>${t("Высокий контраст")}</span></label>
    <p role="alert" data-settings-error>${escapeHtml(settingsState.displaySettingsError)}</p></section>
    ${renderAutostartSettings()}
    ${renderNotificationSettings()}
    <section class="settings-section"><h2>${t("Задачи")}</h2><form data-preferences-form>
      <label for="reminder-minutes">${t("Время до напоминания, минуты")}</label><input id="reminder-minutes" name="reminderMinutes" type="number" min="1" max="1439" step="1" required value="${settingsState.preferences.reminderMinutes}" ${settingsState.preferencesReady ? "" : "disabled"}/>
      <label for="archive-hours">${t("Архивировать через, часы")}</label><input id="archive-hours" name="archiveHours" type="number" min="1" max="8760" step="1" required value="${settingsState.preferences.archiveHours}" ${settingsState.preferencesReady ? "" : "disabled"}/>
      <p>${t("Срок отсчитывается от создания задачи. Архив сохраняет задачи и историю.")}</p>
      <button class="retry-button" type="submit" ${settingsState.preferencesReady ? "" : "disabled"}>${t("Сохранить")}</button><p role="status" data-preferences-status>${escapeHtml(settingsState.preferencesError)}</p>
    </form></section>
    <section class="settings-section shortcut-section" aria-labelledby="shortcuts-heading"><h2 id="shortcuts-heading">${t("Горячие клавиши")}</h2>
      <p>${t("Нажмите поле и сочетание клавиш, затем сохраните. Escape отменяет ввод. Команды задач работают при фокусе на строке.")}</p>
      <p role="alert">${escapeHtml(settingsState.shortcutsError)}</p>
      <div class="shortcut-table" role="group" aria-label="${t("Горячие клавиши")}">
      ${([...Object.keys(shortcutLabels), "overlay"] as (ShortcutAction | "overlay")[]).map((action) => {
        const value = action === "overlay" ? settingsState.overlayShortcut : settingsState.shortcuts[action];
        return `<form class="shortcut-row" aria-label="${action === "overlay" ? t("Оверлей") : shortcutLabels[action]}" data-shortcut-form="${action}"><div><label for="shortcut-${action}">${action === "overlay" ? t("Показать / скрыть оверлей") : shortcutLabels[action]}</label><small>${action === "overlay" ? t("Глобально") : t("В приложении")}</small></div><div><input id="shortcut-${action}" data-shortcut-capture data-combination="${escapeHtml(value)}" value="${escapeHtml(displayShortcut(value))}" readonly aria-label="${t("Сочетание:")} ${action === "overlay" ? t("Оверлей") : shortcutLabels[action]}" ${settingsState.shortcutsReady ? "" : "disabled"}/></div><div><button class="retry-button" type="submit" ${settingsState.shortcutsReady ? "" : "disabled"}>${t("Сохранить")}</button></div><p role="status" data-shortcut-status>${action === "overlay" && !settingsState.overlayShortcutAvailable ? t("Не удалось зарегистрировать сочетание. Выберите другое.") : ""}</p></form>`;
    }).join("")}</div>
    </section>
    ${renderBackupSettings()}
    <section class="settings-section"><h2>${t("Данные")}</h2><button class="retry-button" type="button" data-export-json>${t("Выгрузить JSON в Загрузки")}</button><p role="status" data-export-status></p><div class="settings-actions"><button type="button" class="danger-action" data-clear-data="tasks" ${tasksState.loadFailed ? "disabled" : ""}>${t("Очистить задачи")}</button><button type="button" class="danger-action" data-clear-data="allData">${t("Сбросить данные")}</button></div></section>
    <section class="settings-section"><h2>${t("Диагностика")}</h2><p>${t("Журналы находятся в папке данных → logs. Хранятся четыре файла до 256 КБ каждый, без названий задач и таймеров.")}</p><p role="alert" data-diagnostics-warning></p></section>
    <section class="settings-section"><h2>${t("О приложении")}</h2><p class="about-links"><a href="https://taskmaster339.github.io/" data-about-link>${t("Персональный сайт")}</a><a href="https://github.com/TAskMAster339/taskMaster" data-about-link>GitHub</a></p><p>taskMaster${settingsState.appVersion ? ` · ${escapeHtml(settingsState.appVersion)}` : ""}</p>${settingsState.appVersionError ? `<p role="alert">${escapeHtml(settingsState.appVersionError)}</p>` : ""}</section>
  </main></div>`;
    effects.bindEvents();
    bindBackupSettings();
    bindAutostartSettings();
    root.querySelectorAll<HTMLInputElement>("[data-shortcut-capture]").forEach((input) => {
        input.addEventListener("keydown", (event) => {
            if (event.key === "Tab")
                return;
            event.preventDefault();
            event.stopPropagation();
            const action = input.closest<HTMLFormElement>("form")!.dataset.shortcutForm as ShortcutAction | "overlay";
            if (event.key === "Escape") {
                const value = action === "overlay" ? settingsState.overlayShortcut : settingsState.shortcuts[action];
                input.dataset.combination = value;
                input.value = displayShortcut(value);
                input.blur();
                return;
            }
            const combination = keyboardCombination(event);
            if (combination) {
                input.dataset.combination = combination;
                input.value = displayShortcut(combination);
            }
        });
    });
    root.querySelectorAll<HTMLFormElement>("[data-shortcut-form]").forEach((form) => form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const action = form.dataset.shortcutForm as ShortcutAction | "overlay";
        const input = form.querySelector<HTMLInputElement>("input")!;
        const button = form.querySelector<HTMLButtonElement>("button")!;
        const status = form.querySelector<HTMLElement>("[data-shortcut-status]")!;
        button.disabled = true;
        input.disabled = true;
        try {
            if (action === "overlay") {
                const result = await invoke("set_overlay_shortcut", { shortcut: input.dataset.combination! });
                settingsState.overlayShortcut = result.shortcut;
                settingsState.overlayShortcutAvailable = result.available;
            }
            else
                settingsState.shortcuts = await invoke("update_shortcut", { action, combination: input.dataset.combination });
            status.textContent = t("Сохранено");
        }
        catch (error) {
            status.textContent = backendMessage(error);
        }
        finally {
            button.disabled = false;
            input.disabled = false;
        }
    }));
    root.querySelector<HTMLFormElement>("[data-preferences-form]")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const values = new FormData(form);
        const next = { reminderMinutes: Number(values.get("reminderMinutes")), archiveHours: Number(values.get("archiveHours")) };
        const button = form.querySelector<HTMLButtonElement>("button")!;
        button.disabled = true;
        const status = form.querySelector<HTMLElement>("[data-preferences-status]")!;
        try {
            await invoke("update_preferences", next);
            settingsState.preferences = next;
            status.textContent = t("Сохранено");
        }
        catch (error) {
            status.textContent = backendMessage(error);
        }
        finally {
            button.disabled = false;
        }
    });
    root.querySelector<HTMLButtonElement>("[data-export-json]")?.addEventListener("click", async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        const status = root.querySelector<HTMLElement>("[data-export-status]")!;
        try {
            const path = await invoke("export_user_data", { theme: settingsState.theme });
            status.textContent = `${t("Сохранено:")} ${path}`;
        }
        catch (error) {
            status.textContent = backendMessage(error);
        }
        finally {
            button.disabled = false;
        }
    });
    root.querySelector<HTMLSelectElement>("[data-theme-select]")?.addEventListener("change", (event) => {
        const value = (event.target as HTMLSelectElement).value as Theme;
        try {
            localStorage.setItem(themeStorageKey, value);
            settingsState.theme = value;
            applyTheme();
        }
        catch {
            root.querySelector<HTMLElement>("[data-settings-error]")!.textContent = t("Не удалось сохранить тему. Повторите попытку.");
        }
    });
    root.querySelectorAll<HTMLButtonElement>("[data-clear-data]").forEach((button) => button.addEventListener("click", () => effects.openClearData(button.dataset.clearData as ClearMode)));
    root.querySelectorAll<HTMLAnchorElement>("[data-about-link]").forEach((link) => link.addEventListener("click", async (event) => {
        event.preventDefault();
        try {
            await invoke("open_about_link", { url: link.href });
        }
        catch (error) {
            root.querySelector<HTMLElement>("[data-settings-error]")!.textContent = backendMessage(error);
        }
    }));
    root.querySelector<HTMLSelectElement>("[data-language-select]")?.addEventListener("change", (event) => { void saveDisplaySettings({ ...settingsState.displaySettings, language: (event.target as HTMLSelectElement).value as Language }); });
    root.querySelector<HTMLInputElement>("[data-high-contrast]")?.addEventListener("change", (event) => { void saveDisplaySettings({ ...settingsState.displaySettings, highContrast: (event.target as HTMLInputElement).checked }); });
    const settingsPage = root.querySelector<HTMLElement>(".settings-view");
    if (settingsPage)
        settingsPage.scrollTop = previousScrollTop;
    void refreshDiagnosticsWarning();
}
export function applyDisplaySettings(next: DisplaySettings): void {
    const changed = next.language !== settingsState.displaySettings.language || next.highContrast !== settingsState.displaySettings.highContrast;
    settingsState.displaySettings = next;
    setLanguage(next.language);
    document.documentElement.lang = next.language;
    skipLink.textContent = t("Перейти к содержимому");
    applyTheme();
    if (changed && getCurrentWindow().label !== "overlay") {
        const focusedId = (document.activeElement as HTMLElement | null)?.id;
        effects.render(true);
        effects.renderDeletionUndos();
        if (focusedId)
            document.getElementById(focusedId)?.focus({ preventScroll: true });
        void refreshNotificationStatus();
    }
}
export async function saveDisplaySettings(next: DisplaySettings): Promise<void> {
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-language-select], [data-high-contrast]").forEach((control) => { control.disabled = true; });
    try {
        const previous = settingsState.displaySettings;
        const saved = await invoke("update_display_settings", { settings: next });
        settingsState.displaySettingsError = "";
        applyDisplaySettings(saved);
        announce(previous.language !== next.language ? t("Язык изменён") : t("Контраст изменён"));
    }
    catch (error) {
        settingsState.displaySettingsError = backendMessage(error);
    }
    finally {
        const focusedId = (document.activeElement as HTMLElement | null)?.id;
        effects.render(true);
        if (focusedId)
            document.getElementById(focusedId)?.focus({ preventScroll: true });
    }
}
export async function refreshDiagnosticsWarning(): Promise<void> {
    let warning: string | null;
    try {
        warning = await invoke("get_diagnostics_warning");
    }
    catch (error) {
        warning = backendMessage(error);
    }
    const status = root.querySelector<HTMLElement>("[data-diagnostics-warning]");
    if (status)
        status.textContent = backendText(warning ?? "");
}
export function bindSettingsEvents(scope: ParentNode): void {
    scope.querySelector<HTMLButtonElement>("[data-toggle-overlay]")?.addEventListener("click", async () => {
        try {
            await invoke("toggle_task_overlay");
        }
        catch (error) {
            tasksState.errorMessage = backendMessage(error);
            effects.render(true);
        }
    });
    scope.querySelector<HTMLButtonElement>("[data-open-overlay-shortcut]")?.addEventListener("click", () => { settingsState.overlayShortcutError = ""; settingsState.overlayShortcutDialogOpen = true; effects.render(true); });
    scope.querySelector<HTMLButtonElement>("[data-close-overlay-shortcut]")?.addEventListener("click", () => { settingsState.overlayShortcutDialogOpen = false; settingsState.overlayShortcutError = ""; effects.render(true); });
    scope.querySelector<HTMLFormElement>("[data-overlay-shortcut-form]")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const shortcut = String(new FormData(event.currentTarget as HTMLFormElement).get("shortcut") ?? "").trim();
        try {
            const status = await invoke("set_overlay_shortcut", { shortcut });
            settingsState.overlayShortcut = status.shortcut;
            settingsState.overlayShortcutAvailable = status.available;
            settingsState.overlayShortcutError = "";
            settingsState.overlayShortcutDialogOpen = false;
            effects.render(true);
        }
        catch (error) {
            settingsState.overlayShortcutError = backendMessage(error);
            effects.render(true);
        }
    });
}
export async function loadShortcuts(): Promise<void> {
    try {
        settingsState.shortcuts = await invoke("get_shortcuts");
        settingsState.shortcutsReady = true;
        settingsState.shortcutsError = "";
    }
    catch (error) {
        settingsState.shortcutsReady = false;
        settingsState.shortcutsError = backendMessage(error);
    }
    if (getCurrentWindow().label !== "overlay" && appState.activeView === "settings")
        effects.render(true);
}
type Effects = {
    render: typeof import("../../app/view.ts").render;
    refreshTasks: typeof import("../tasks/controller.ts").refreshTasks;
    refreshTimers: typeof import("../timers/controller.ts").refreshTimers;
    refreshDeletionUndos: typeof import("../deletions/controller.ts").refreshDeletionUndos;
    renderSidebar: typeof import("../../app/view.ts").renderSidebar;
    bindEvents: typeof import("../../app/view.ts").bindEvents;
    openClearData: typeof import("../deletions/controller.ts").openClearData;
    renderDeletionUndos: typeof import("../deletions/controller.ts").renderDeletionUndos;
};
let effects: Effects;
export function configureSettings(callbacks: Effects): void { effects = callbacks; }
