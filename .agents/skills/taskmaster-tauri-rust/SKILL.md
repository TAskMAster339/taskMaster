---
name: taskmaster-tauri-rust
description: Use when implementing or changing Taskmaster's Rust domain layer, Tauri commands, SQLite persistence, task history, reminders, independent timers, tray, overlay, or desktop lifecycle.
---

# Taskmaster Tauri and Rust

Use this workflow for backend and native desktop behavior in this repository.

1. Read the relevant behavior in `docs/BEHAVIOR.md` and module ownership in `docs/DEVELOPMENT.md`, then inspect the current Rust/Tauri implementation before editing.
2. Keep domain rules and persistence in Rust. Expose focused, typed Tauri commands; return actionable errors rather than swallowing failures or exposing raw database details to the UI.
3. Preserve the specified invariants: stable task IDs, manual queue order, 24-hour archival without deletion, append-only history, recoverable local storage, and multiple independent timers may run concurrently. Put related database changes in transactions.
4. Keep app capabilities and plugins minimal. No account, network, analytics, or cloud behavior belongs in MVP.
5. Tauri plugins and platform APIs change. Before using a plugin or Windows-specific API, check the current official Tauri docs and verify the required capabilities/permissions and supported platforms. Do not guess plugin command names or promise reminders after process exit.
6. Add or update focused Rust tests for domain rules when the project test harness exists. Use the verification skill for broader build/runtime checks.

Do not implement a calendar timeline, automatic task sorting, or a new product feature unless the user updates the specification.
