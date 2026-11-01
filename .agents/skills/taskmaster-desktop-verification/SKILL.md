---
name: taskmaster-desktop-verification
description: Use when validating Taskmaster code changes, Rust or frontend checks, Windows packaging, tray/overlay/notification behavior, persistence recovery, or release readiness.
---

# Taskmaster Desktop Verification

Use this workflow to select and report checks that match the changed behavior.

1. Inspect manifests and existing scripts first; run the repository's actual commands rather than assuming a scaffold or command exists.
2. For Rust domain/storage changes, run formatting, linting and relevant unit/integration tests that are configured. For frontend changes, run configured type-check/lint/build checks and exercise the affected interaction. Do not add a new toolchain solely to make a generic checklist appear complete.
3. For data lifecycle changes, cover create/reorder/complete/reopen/archive/restore boundaries, persistence after restart, and preservation of event history. For focus timer changes, cover pause/resume, finish/cancel and recovery after process interruption.
4. For native Windows behavior, validate on a Windows build: installed-app notifications, tray hide/show and exit, global shortcut conflicts, overlay topmost/position recovery, startup preference, and installer launch. A successful WSL/Linux compile does not verify Windows integration.
5. Test notifications while the process remains in the tray. Do not claim delivery after full application exit, sleep, or shutdown unless a separate supported mechanism has been implemented and verified.
6. Exercise backup and restore against a disposable test database, including invalid/corrupt input; confirm recovery does not overwrite the only existing data.
7. In the handoff, distinguish automated checks, manual smoke checks, and unverified platform behavior. Report exact commands and failures; do not claim checks that were not run.

Consult `ТЗ.md` for the acceptance scenarios and current platform limits.
