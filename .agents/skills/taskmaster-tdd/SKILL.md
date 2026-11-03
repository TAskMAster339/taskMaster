---
name: taskmaster-tdd
description: Use when implementing or changing Taskmaster behavior that can be specified with automated tests; guide the change through a test-first Red–Green–Refactor cycle.
---

# Taskmaster TDD

Use a short Red–Green–Refactor cycle for behavior changes.

1. Read the relevant acceptance criteria in `docs/BEHAVIOR.md` and inspect existing code and test conventions. State the observable behavior and boundary cases the change must satisfy.
2. Write the smallest useful test for one behavior before production code. Prefer public behavior and domain rules over private implementation details. Use temporary databases and controllable clocks for persistence and time-sensitive rules.
3. Run that test and confirm it fails for the expected reason. Fix a broken test setup or compilation problem before treating it as a meaningful red result.
4. Make the smallest production change that passes the test. Run the focused test, then relevant adjacent tests; refactor only while keeping them green.
5. Add tests for regressions and meaningful boundaries: configurable archive cutoff (24 hours by default), queue position changes, restore/history behavior, timer pause/resume and interrupted sessions, and invalid persistence input when those areas change.
6. Keep tests deterministic and independent of real wall-clock waits, Windows notification popups, network access, or user data. Test scheduling decisions and state transitions in isolation; use the desktop verification skill for OS integration smoke checks.
7. For a UI-only visual adjustment, use a relevant component/accessibility test if the project has one and verify the rendered behavior separately. Do not invent brittle pixel assertions solely to satisfy TDD.
8. Report the test-first sequence and exact checks run. Never claim a test failed first unless that red run was observed.

Do not use this skill to add tests for documentation-only edits. If no test harness exists yet, establish the smallest appropriate one for the behavior being implemented rather than pretending an unrun test passed.
