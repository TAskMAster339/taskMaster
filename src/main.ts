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
let mouseDragActive = false;
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

function renderTask(task: Task, index: number, completed = false): string {
  const isEditing = editingTaskId === task.id;
  const title = isEditing
    ? `<form class="rename-form" data-rename-form="${task.id}">
        <input class="rename-input" name="title" aria-label="Новое название задачи" value="${escapeHtml(task.title)}" required />
      </form>`
    : `<span class="task-title">${escapeHtml(task.title)}</span>`;

  return `
    <li class="task-row ${completed ? "is-completed" : ""}" data-task-id="${task.id}" data-reorderable="${!completed}" ${completed ? "" : `tabindex="0" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown F2" aria-label="${escapeHtml(task.title)}. Alt и стрелки вверх или вниз меняют порядок. F2 изменяет название."`}>
      ${completed ? "" : `<span class="task-position" aria-label="Задача ${index + 1}">${String(index + 1).padStart(2, "0")}</span>`}
      <button class="task-check ${completed ? "checked" : ""}" type="button"
        data-toggle-task="${task.id}" aria-label="${completed ? "Вернуть в очередь" : "Отметить выполненной"} — ${escapeHtml(task.title)}"
        aria-pressed="${completed}" ${saving ? "disabled" : ""}>
        <span aria-hidden="true">${completed ? "✓" : ""}</span>
      </button>
      <div class="task-content">${title}</div>
      ${completed ? `<span class="completed-label">Готово</span>` : ""}
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
      <aside class="sidebar" aria-label="taskMaster">
        <a class="brand" href="#today" aria-label="taskMaster — Сегодня">task<span>Master</span></a>
        <nav class="navigation" aria-label="Разделы">
          <a class="nav-item is-current" href="#today" aria-current="page"><span class="nav-index">01</span>Сегодня<span class="nav-count">${activeTasks().length}</span></a>
        </nav>
      </aside>

      <main class="main-content" id="today">
        <section class="day-heading" aria-labelledby="page-title">
          <div>
            <p class="eyebrow">${escapeHtml(dateLabel)} / ${new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date())}</p>
            <h1 id="page-title">План на день<span class="heading-period">.</span></h1>
            <p class="date-line">Порядок задаёте вы.</p>
          </div>
          <div class="day-progress" aria-label="Осталось ${active.length} задач">
            <span class="progress-count">${String(active.length).padStart(2, "0")}</span>
            <span class="progress-label">ОСТАЛОСЬ</span>
          </div>
        </section>

        <form class="quick-add" id="quick-add-form">
          <input id="new-task-title" name="title" type="text" autocomplete="off"
            placeholder="Новая задача" aria-label="Название новой задачи" ${saving ? "disabled" : ""} />
          <kbd>ENTER <span aria-hidden="true">↵</span></kbd>
          <button class="add-button" type="submit" aria-label="Добавить задачу" ${saving ? "disabled" : ""}>＋</button>
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
            ${active.length > 0 ? "<span class=\"reorder-hint\">↕ РУЧНОЙ ПОРЯДОК</span>" : ""}
          </div>
          ${taskList}
        </section>

        <details class="completed-section ${completed.length ? "" : "is-empty"}" ${completed.length ? "" : "aria-disabled=\"true\""}>
          <summary>
            <span class="summary-left"><span class="summary-chevron" aria-hidden="true">›</span><span>Выполнено</span><span class="section-count">${completed.length}</span></span>
            ${completed.length ? '<span class="completed-summary">Отличная работа</span>' : ""}
          </summary>
          ${completed.length ? `<ol class="task-list completed-list" aria-label="Выполненные задачи">${completed.map((task, index) => renderTask(task, index, true)).join("")}</ol>` : ""}
        </details>
      </main>
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
  root.querySelector<HTMLDetailsElement>(".completed-section.is-empty > summary")?.addEventListener("click", (event) => {
    event.preventDefault();
  });

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

  root.querySelectorAll<HTMLLIElement>(".task-row[data-reorderable=true]").forEach((row) => {
    row.querySelector<HTMLElement>(".task-content")?.addEventListener("dblclick", () => {
      if (editingTaskId === row.dataset.taskId) return;
      editingTaskId = row.dataset.taskId ?? null;
      errorMessage = "";
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
    form.querySelector<HTMLInputElement>(".rename-input")?.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const taskId = form.dataset.renameForm;
      editingTaskId = null;
      render();
      if (taskId) root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`)?.focus();
    });
  });

  root.querySelectorAll<HTMLLIElement>(".task-row[data-reorderable=true]").forEach((row) => {
    row.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button, input, a"))) return;
      const sourceId = row.dataset.taskId;
      if (!sourceId) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let dragPreview: HTMLLIElement | null = null;
      mouseDragActive = false;

      const handleMouseMove = (moveEvent: MouseEvent): void => {
        if (!mouseDragActive && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
        mouseDragActive = true;
        moveEvent.preventDefault();
        window.getSelection()?.removeAllRanges();
        document.body.classList.add("is-task-dragging");
        row.classList.add("is-drag-source");
        if (!dragPreview) {
          dragPreview = row.cloneNode(true) as HTMLLIElement;
          dragPreview.classList.remove("is-drag-source", "drop-target", "drop-before", "drop-after");
          dragPreview.classList.add("task-drag-preview");
          dragPreview.dataset.reorderable = "false";
          dragPreview.removeAttribute("data-task-id");
          dragPreview.removeAttribute("tabindex");
          dragPreview.removeAttribute("aria-label");
          dragPreview.setAttribute("aria-hidden", "true");
          dragPreview.querySelector<HTMLButtonElement>(".task-check")?.removeAttribute("disabled");
          const bounds = row.getBoundingClientRect();
          dragPreview.style.width = `${bounds.width}px`;
          document.body.append(dragPreview);
        }
        dragPreview.style.left = `${Math.min(moveEvent.clientX + 12, Math.max(8, window.innerWidth - dragPreview.offsetWidth - 8))}px`;
        dragPreview.style.top = `${Math.min(moveEvent.clientY + 10, Math.max(8, window.innerHeight - dragPreview.offsetHeight - 8))}px`;
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLLIElement>(".task-row[data-reorderable=true]") ?? null;
        root.querySelectorAll(".task-row").forEach((item) => item.classList.remove("drop-target", "drop-before", "drop-after"));
        if (target && target.dataset.taskId !== sourceId) {
          target.classList.add("drop-target", moveEvent.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2 ? "drop-before" : "drop-after");
        }
      };

      const handleMouseUp = (upEvent: MouseEvent): void => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest<HTMLLIElement>(".task-row[data-reorderable=true]") ?? null;
        const targetId = target?.dataset.taskId;
        const shouldSave = mouseDragActive && targetId && targetId !== sourceId;
        row.classList.remove("is-drag-source");
        dragPreview?.remove();
        root.querySelectorAll(".task-row").forEach((item) => item.classList.remove("drop-target", "drop-before", "drop-after"));
        document.body.classList.remove("is-task-dragging");
        mouseDragActive = false;
        if (!shouldSave || !target) return;

        const originalIds = activeTasks().map((task) => task.id);
        const ids = [...originalIds];
        const sourceIndex = ids.indexOf(sourceId);
        const targetIndex = ids.indexOf(targetId);
        if (sourceIndex < 0 || targetIndex < 0) return;
        const afterTarget = upEvent.clientY >= target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
        ids.splice(sourceIndex, 1);
        let destinationIndex = targetIndex - (sourceIndex < targetIndex ? 1 : 0) + (afterTarget ? 1 : 0);
        destinationIndex = Math.max(0, Math.min(destinationIndex, ids.length));
        ids.splice(destinationIndex, 0, sourceId);
        if (ids.some((id, index) => id !== originalIds[index])) void saveOrder(ids, destinationIndex);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    });
  });

  root.querySelectorAll<HTMLLIElement>(".task-row[data-reorderable=true]").forEach((row) => {
    row.addEventListener("keydown", (event) => {
      if (event.key === "F2") {
        event.preventDefault();
        editingTaskId = row.dataset.taskId ?? null;
        render();
        return;
      }
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
