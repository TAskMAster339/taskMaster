---
name: taskmaster-ui
description: Use when designing or changing Taskmaster screens, task rows, overlay, interaction states, keyboard navigation, layout, or light/dark themes.
---

# Taskmaster UI

Use this workflow for frontend changes in this repository.

1. Read the relevant UI requirements in `docs/BEHAVIOR.md` and inspect existing screens/styles before changing them.
1a. Read `DESIGN.md` before changing visual styling. Treat its palette, typography, component states, and motion rules as the shared system; update the document when a requested change revises that system.
2. Optimize for the core use: capture tasks quickly, arrange a manual queue, complete the next task, and glance at the current next task. Keep secondary controls quiet and avoid adding project-management complexity.
2a. Keep interface copy literal and short. Do not add slogans, motivational phrases, redundant counts, or explanations of obvious controls; show text only when it communicates an action, state, error, or accessibility information.
3. Preserve the specified interaction model: no calendar timeline, no mandatory task dates/durations, and no hidden auto-sorting. Time is optional for reminders; timers live in a separate independent tab.
4. Provide clear empty, loading, saving/error, notification-permission, completed, archived, and timer states wherever they apply. Never imply a change was saved when the backend rejected it.
5. Support light, dark, and system themes, keyboard operation, visible focus, accessible names, and a keyboard alternative to drag-and-drop reordering.
6. Keep responsive behavior usable at the minimum width in `docs/BEHAVIOR.md`; check long task names, high DPI, completed lists, and overlay edge placement.
6a. Reordering uses the shared project interaction: hold the left mouse button for 180 ms on a non-interactive area, show a pointer-offset preview, move neighboring items dynamically with reduced-motion-aware animation, update task numbers immediately, suppress text selection, and support Escape cancellation and keyboard reorder. Locked overlays disallow timer reorder. Commit task order only on drop and preserve the backend order on failure.
7. Reuse the current project styling and components when present. Do not add a UI framework or design dependency without a concrete need.

For native notification, window, tray, or persistence behavior, also use `$taskmaster-tauri-rust`.
