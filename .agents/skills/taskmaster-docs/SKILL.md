---
name: taskmaster-docs
description: Maintain Taskmaster's developer and user documentation, reconcile it with the final feature diff, and update build, architecture, or platform guides before a feature is committed.
---

# Taskmaster Documentation

Use this skill for documentation work in this repository and for the documentation step at the end of a feature. It does not authorize implementing a new feature or porting the application merely because a guide mentions it.

## Establish the actual change

Read `AGENTS.md`, inspect the working tree and final feature diff, and read only the affected source, manifests, tests and docs. Preserve unrelated edits. Treat existing docs as requirements to reconcile with code, not proof that a command was run or a platform is supported. Keep planned behavior separate from current behavior.

Start with the [documentation index](../../../docs/README.md). Use the routing table in [feature completion](../../../docs/ADDING_FEATURES.md#завершение-фичи) to choose the source of truth for behavior, architecture/IPC/data, commands, platform status, design or contributor workflow. Keep the root README short; link detailed material instead of copying it. Link new pages from the index.

## Update from evidence

- Describe the shipped result, its inputs/outputs, errors and relevant limits. For a changed IPC contract, follow both the Rust command/registration and TypeScript DTO/client/callers. For schema changes, inspect migration and backup compatibility paths. Do not invent an API, configuration option or migration facility absent from the code.
- Verify build and test examples against `package.json`, Cargo manifests, Tauri config and actual workflows. Prefer non-mutating CLI help/metadata and an appropriate available check. Do not execute reset, restore, installer, autostart or publication merely to validate prose.
- For external prerequisites, plugins and packaging, check current official documentation and cite it near the instruction. In `docs/PORTING.md`, distinguish setup guidance, experimental compilation and native runtime verification; record the target OS/architecture and actual verification limits. A green Windows build does not prove Linux/macOS support.
- Preserve existing recovery, local-data and offline constraints. Do not include user databases, private logs or machine-specific absolute paths in examples. Use repository-relative links and commands from the repository root unless a different working directory is explicit.
- Keep documentation in Russian, product names and code identifiers exact, and code examples copyable. Avoid duplicating whole schemas or command catalogs that already have clear source links.

## Finish the feature

Perform this review after implementation, checks and refactoring, before the changelog and commit. Check relative links and anchors, local image paths, code fences, example command names/options and consistency across touched guides. If instructions cannot be run on the current OS, say so instead of recording a successful test.

Update `CHANGELOG.md` only for the feature or a meaningful user/developer workflow change, following `AGENTS.md`. Keep associated documentation in the same feature commit. If the final diff does not invalidate documentation, explain that in the PR/handoff without making a cosmetic edit solely to satisfy the step.

Report which documents changed, the checks actually performed and remaining verification limits. Documentation review is a required completion step; it is not evidence that native runtime checks passed.
