---
name: taskmaster-design
description: Use when defining or revising Taskmaster's visual direction, screen structure, interaction design, component states, or design tokens before or alongside implementation.
---

# Taskmaster Design

Use this workflow for product and visual design decisions; use `$taskmaster-ui` when directly implementing frontend code.

1. Read the relevant user scenario and UI constraints in `ТЗ.md`, then inspect the current interface and reusable components if they exist. Design for the actual small, single-user daily-planning workflow.
1a. Read `DESIGN.md` before making visual decisions. Keep new work aligned with its palette, typography, component states, and motion rules; revise it when the user approves a lasting visual-system change.
2. Define the screen's purpose, primary action, information hierarchy, and important states before choosing decoration. Keep capture, manual ordering, completion, focus timing, history, and the next-task overlay easy to distinguish.
2a. Use concise, literal interface copy. Avoid slogans, motivational phrases, redundant counters, and decorative explanations; add copy only when it clarifies an action, state, error, or accessibility need.
3. Preserve the product's minimal interaction model: a clear task queue, optional reminder time, explicit focus timer, and no project-management dashboard or calendar timeline.
4. Use a quiet, legible visual system that works in light, dark, and Windows system themes. Prefer semantic color tokens, consistent spacing and typography, restrained borders/surfaces, and clear contrast for active, completed, archived, warning, and focus states. Do not hardcode colors separately into individual controls when a shared token fits.
5. Design empty, hover, focus, pressed, disabled, saving/error, and long-content states where relevant. Account for keyboard use, visible focus, accessible labels, DPI scaling, minimum window width, and the compact overlay.
6. Keep icons and decoration subordinate to task titles and the next action. Use existing code-native CSS/SVG assets where appropriate; do not introduce image generation, a UI framework, or a design dependency unless the requested result needs it.
7. When asked for a design proposal, present concrete screen structure and token/component decisions that can be implemented without inventing product behavior. When asked to polish an existing screen, make the focused changes and inspect the result at representative sizes and both themes.

For frontend implementation, combine this with `$taskmaster-ui`; for interaction or domain changes that need regression coverage, combine it with `$taskmaster-tdd`.
