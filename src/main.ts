import { invoke } from "@tauri-apps/api/core";

type TaskStatus = "active" | "completed";

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  position: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface BackendError {
  code?: string;
  message?: string;
}

const root: HTMLDivElement = document.querySelector<HTMLDivElement>("#app") ?? (() => {
  throw new Error("Application root was not found");
})();

let tasks: Task[] = [];
let loading = true;
let saving = false;
let errorMessage = "";
let loadFailed = false;
let editingTaskId: string | null = null;
let draggedTaskId: string | null = null;
let announcement = "";

const dateLabel = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
}).format(new Date());

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function backendMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as BackendError).message;
    if (typeof message === "string") return message;
  }
  return "Не удалось сохранить изменения. Попробуйте ещё раз.";
}

function activeTasks(): Task[] {
  return tasks.filter((task) => task.status === "active");
}

function completedTasks(): Task[] {
  return tasks.filter((task) => task.status === "completed");
}

function remainingLabel(count: number): string {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "дел осталось";
  const lastDigit = count % 10;
  if (lastDigit === 1) return "дело осталось";
  if (lastDigit >= 2 && lastDigit <= 4) return "дела осталось";
  return "дел осталось";
}

function renderTask(task: Task, index: number, completed = false): string {
  const isEditing = editingTaskId === task.id;
  const title = isEditing
    ? `<form class="rename-form" data-rename-form="${task.id}">
        <input class="rename-input" name="title" aria-label="Новое название задачи" value="${escapeHtml(task.title)}" required />
        <button class="icon-button confirm-edit" type="submit" aria-label="Сохранить название">✓</button>
        <button class="icon-button cancel-edit" type="button" data-cancel-edit="${task.id}" aria-label="Отменить изменение">×</button>
      </form>`
    : `<span class="task-title">${escapeHtml(task.title)}</span>`;

  return `
    <li class="task-row ${completed ? "is-completed" : ""}" data-task-id="${task.id}" draggable="${!completed}" ${completed ? "" : `tabindex="0" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" aria-label="${escapeHtml(task.title)}. Alt и стрелки вверх или вниз меняют порядок."`}>
      <button class="task-check ${completed ? "checked" : ""}" type="button"
        data-toggle-task="${task.id}" aria-label="${completed ? "Вернуть в очередь" : "Отметить выполненной"} — ${escapeHtml(task.title)}"
        aria-pressed="${completed}" ${saving ? "disabled" : ""}>
        <span aria-hidden="true">${completed ? "✓" : ""}</span>
      </button>
      <div class="task-content">${title}</div>
      ${completed
        ? `<span class="completed-label">Готово</span>`
        : `<span class="task-position" aria-label="Задача ${index + 1}">${String(index + 1).padStart(2, "0")}</span>
           <button class="icon-button edit-task" type="button" data-edit-task="${task.id}" aria-label="Изменить название: ${escapeHtml(task.title)}" title="Изменить название">✎</button>`}
    </li>`;
}

function render(): void {
  const active = activeTasks();
  const completed = completedTasks();
  const taskList = loading
    ? `<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Загружаем очередь…</span></div>`
    : active.length
      ? `<ol class="task-list" aria-label="Очередь задач">${active.map((task, index) => renderTask(task, index)).join("")}</ol>`
      : loadFailed
        ? `<div class="empty-state load-error-state">
             <span class="empty-mark" aria-hidden="true">!</span>
             <strong>Очередь недоступна</strong>
             <span>Попробуйте загрузить задачи ещё раз.</span>
             <button class="retry-button" type="button" data-retry-load>Повторить</button>
           </div>`
        : `<div class="empty-state">
           <span class="empty-mark" aria-hidden="true">✳</span>
           <strong>Пока чистый лист</strong>
           <span>Добавьте первое дело — и начните с малого.</span>
         </div>`;

  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="#today" aria-label="taskMaster — Сегодня">
          <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>task<span class="brand-accent">Master</span></span>
        </a>
        <div class="topbar-right">
          <span class="offline-indicator"><i aria-hidden="true"></i> Локально</span>
          <span class="avatar" aria-hidden="true">Я</span>
        </div>
      </header>

      <main class="main-content">
        <section class="day-heading" aria-labelledby="page-title">
          <div>
            <p class="eyebrow">МОЙ ПЛАН</p>
            <h1 id="page-title">Сегодня<span class="heading-period">.</span></h1>
            <p class="date-line">${escapeHtml(dateLabel)}</p>
          </div>
          <div class="day-progress" aria-label="Осталось ${active.length} задач">
            <span class="progress-count">${String(active.length).padStart(2, "0")}</span>
            <span class="progress-label">${remainingLabel(active.length)}</span>
          </div>
        </section>

        <form class="quick-add" id="quick-add-form">
          <span class="add-symbol" aria-hidden="true">＋</span>
          <input id="new-task-title" name="title" type="text" autocomplete="off"
            placeholder="Добавить задачу…" aria-label="Название новой задачи" ${saving ? "disabled" : ""} />
          <kbd>Enter <span aria-hidden="true">↵</span></kbd>
          <button class="add-button" type="submit" aria-label="Добавить задачу" ${saving ? "disabled" : ""}>Добавить</button>
        </form>

        <p class="error-banner" role="alert" ${errorMessage ? "" : "hidden"}>
          <span aria-hidden="true">!</span> ${escapeHtml(errorMessage)}
        </p>

        <section class="queue-section" aria-labelledby="queue-title">
          <div class="section-heading">
            <div class="section-title-wrap">
              <h2 id="queue-title">Очередь</h2>
              <span class="section-count">${active.length}</span>
            </div>
            ${active.length > 0 ? "<span class=\"reorder-hint\">Перетаскивайте · Alt + ↑/↓ меняет порядок</span>" : ""}
          </div>
          ${taskList}
        </section>

        ${completed.length
          ? `<details class="completed-section">
              <summary>
                <span class="summary-left"><span class="summary-chevron" aria-hidden="true">›</span><span>Выполнено</span><span class="section-count">${completed.length}</span></span>
                <span class="completed-summary">Отличная работа</span>
              </summary>
              <ol class="task-list completed-list" aria-label="Выполненные задачи">${completed.map((task, index) => renderTask(task, index, true)).join("")}</ol>
            </details>`
          : ""}
      </main>
      <footer class="app-footer">
        <span>Ваши задачи хранятся только на этом устройстве</span>
        <span class="footer-brand">taskMaster <i aria-hidden="true">·</i> 0.1</span>
      </footer>
      <span class="visually-hidden" role="status" aria-live="polite">${escapeHtml(announcement)}</span>
    </div>`;

  bindEvents();
  if (editingTaskId) {
    const input = root.querySelector<HTMLInputElement>(".rename-input");
    input?.focus();
    input?.select();
  }
}

async function refreshTasks(): Promise<void> {
  try {
    tasks = await invoke<Task[]>("list_tasks");
    errorMessage = "";
    loadFailed = false;
  } catch (error) {
    errorMessage = backendMessage(error);
    loadFailed = true;
  } finally {
    loading = false;
    render();
  }
}

async function perform(action: () => Promise<unknown>): Promise<boolean> {
  saving = true;
  errorMessage = "";
  render();
  try {
    await action();
    editingTaskId = null;
    await refreshTasks();
    return !loadFailed;
  } catch (error) {
    errorMessage = backendMessage(error);
    saving = false;
    render();
    return false;
  } finally {
    saving = false;
    render();
  }
}

function bindEvents(): void {
  root.querySelector<HTMLButtonElement>("[data-retry-load]")?.addEventListener("click", () => {
    loading = true;
    errorMessage = "";
    render();
    void refreshTasks();
  });

  root.querySelector<HTMLFormElement>("#quick-add-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = root.querySelector<HTMLInputElement>("#new-task-title");
    const title = input?.value.trim() ?? "";
    if (!title) {
      errorMessage = "Введите название задачи.";
      render();
      root.querySelector<HTMLInputElement>("#new-task-title")?.focus();
      return;
    }
    void perform(() => invoke("create_task", { title }));
  });

  root.querySelectorAll<HTMLButtonElement>("[data-toggle-task]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = tasks.find((item) => item.id === button.dataset.toggleTask);
      if (!task) return;
      const command = task.status === "active" ? "complete_task" : "reopen_task";
      void perform(() => invoke(command, { id: task.id }));
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-edit-task]").forEach((button) => {
    button.addEventListener("click", () => {
      editingTaskId = button.dataset.editTask ?? null;
      errorMessage = "";
      render();
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-cancel-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      editingTaskId = null;
      render();
    });
  });

  root.querySelectorAll<HTMLFormElement>("[data-rename-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const taskId = form.dataset.renameForm;
      const input = form.querySelector<HTMLInputElement>("[name=title]");
      const title = input?.value.trim() ?? "";
      if (!taskId || !title) {
        errorMessage = "Введите название задачи.";
        render();
        return;
      }
      void perform(() => invoke("rename_task", { id: taskId, title }));
    });
  });

  root.querySelectorAll<HTMLLIElement>(".task-row[draggable=true]").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      draggedTaskId = row.dataset.taskId ?? null;
      row.classList.add("is-dragging");
      event.dataTransfer?.setData("text/plain", draggedTaskId ?? "");
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      draggedTaskId = null;
      row.classList.remove("is-dragging");
      root.querySelectorAll(".task-row").forEach((item) => item.classList.remove("drop-target"));
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (row.dataset.taskId !== draggedTaskId) row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const targetId = row.dataset.taskId;
      const sourceId = event.dataTransfer?.getData("text/plain") || draggedTaskId;
      if (!targetId || !sourceId || sourceId === targetId) return;
      const ids = activeTasks().map((task) => task.id);
      const sourceIndex = ids.indexOf(sourceId);
      const targetIndex = ids.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0) return;
      ids.splice(sourceIndex, 1);
      ids.splice(targetIndex, 0, sourceId);
      void saveOrder(ids, targetIndex);
    });
  });

  root.querySelectorAll<HTMLLIElement>(".task-row[draggable=true]").forEach((row) => {
    row.addEventListener("keydown", (event) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const ids = activeTasks().map((task) => task.id);
      const index = ids.indexOf(row.dataset.taskId ?? "");
      const nextIndex = index + (event.key === "ArrowUp" ? -1 : 1);
      if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
      [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
      void saveOrder(ids, nextIndex);
    });
  });
}

async function saveOrder(ids: string[], movedIndex: number): Promise<void> {
  const movedId = ids[movedIndex];
  const saved = await perform(() => invoke("reorder_tasks", { ids }));
  if (!saved) return;
  const index = activeTasks().findIndex((task) => task.id === movedId);
  if (index >= 0) {
    announcement = `Задача перемещена на позицию ${index + 1} из ${activeTasks().length}.`;
    root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(movedId)}"]`)?.focus();
  }
  render();
}

render();
void refreshTasks();
