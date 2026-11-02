---
name: taskmaster-desktop-verification
description: Use when validating Taskmaster code changes, Rust or frontend checks, Windows packaging, tray/overlay/notification behavior, persistence recovery, or release readiness.
---

# Taskmaster Desktop Verification

Use this workflow to select and report checks that match the changed behavior.

1. Inspect manifests and existing scripts first; run the repository's actual commands rather than assuming a scaffold or command exists.
1a. During development, use `npm run tauri dev` for interactive checks and Cargo's default dev/test profiles for compilation and tests. These builds omit release optimization and reuse incremental artifacts. Do not run `tauri build` or `cargo build --release` after routine changes. Use release builds only when the user requests them or when checking packaging, release performance, or release readiness. If a standalone development executable is needed, use `npm run tauri build -- --debug --no-bundle`.
2. For Rust domain/storage changes, run formatting, linting and relevant unit/integration tests that are configured. For frontend changes, run configured type-check/lint/build checks and exercise the affected interaction. Do not add a new toolchain solely to make a generic checklist appear complete.
3. For data lifecycle changes, cover create/reorder/complete/reopen/archive/restore boundaries, persistence after restart, and preservation of event history. For timer changes, cover parallel timers, pause/resume, reset, one-time completion and persistence after restart.
4. For native Windows behavior, validate on a Windows build: installed-app notifications, tray hide/show and exit, global shortcut conflicts, overlay topmost/position recovery, startup preference, and installer launch. A successful WSL/Linux compile does not verify Windows integration.
5. Test notifications while the process remains in the tray. Do not claim delivery after full application exit, sleep, or shutdown unless a separate supported mechanism has been implemented and verified.
6. Exercise backup and restore against a disposable test database, including invalid/corrupt input; confirm recovery does not overwrite the only existing data.
7. In the handoff, distinguish automated checks, manual smoke checks, and unverified platform behavior. Report exact commands and failures; do not claim checks that were not run.
8. After every completed feature, add a concise user-visible entry to `CHANGELOG.md` under `Unreleased` (`Добавлено`, `Изменено`, or `Исправлено`). Include the changelog in that feature's commit. Skip entries for documentation-only process edits that do not change project behavior or contributor workflow.
9. Before a manual GitHub release, verify the release checks succeeded and `Unreleased` contains release notes. The release workflow publishes the Windows executable to a dated/versioned release and updates the rolling `latest` release. Only after both publications succeed, prepare a PR that moves those notes into a version/date section in `CHANGELOG.md` and leaves an empty `Unreleased` section. Merge that PR before the next release. Preserve all older release sections; never clear the whole changelog. If release publication fails, do not archive or clear `Unreleased`.

Consult `README.md` for the acceptance scenarios and current platform limits.
