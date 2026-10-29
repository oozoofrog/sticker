# Dock / Menu Bar Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dock opens Sticker directly; management lives in a small menu.
**Architecture:** Reuse the existing JXA stay-open lifecycle, CLI JSON and owned NSTask. Replace the large controller window with retained NSStatusItem/NSMenu and a small failure-only panel.
**Tech Stack:** OS AppKit/Foundation/JXA, Node VM regression tests.
**Spec:** `docs/superpowers/specs/2026-10-29-access-menubar-design.md`

## Global Constraints

No new daemon, login item, permissions, credentials or network. No source cwd/environment workaround. Native callbacks return promptly. Quit never stops the service. Real Mac checks remain a separate gate.

## Review Focus

- Dock repeated during start/stop must not create duplicate operations.
- Unknown health must never trigger an automatic open after start.
- Menu tracking must not block task cleanup or OS quit.
- Failure panel dismissal must not stop a service or abandon a child.
- Native menu target/selector and retained lifetime require actual Mac testing.

### Task 1: Menu and launch state machine

**Files:** `packaging/macos/Sticker.jxa`, `tests/access-packaging.test.ts`.
**Interfaces:** Existing `requestAction`, `run`, `reopen`, `idle`; new `operationCompleted(verb)` derives follow-on behavior from validated snapshot.

- [ ] Replace old VM expectations with no-window Dock open and explicit stop-confirm assertions; add start-ready-open/unknown-no-open and repeated Dock/quit tests.
- [ ] Run `node --import tsx --test tests/access-packaging.test.ts`; expect failures on old status/large-window behavior.
- [ ] Implement retained native menu, small failure panel, single coalesced open intention, no periodic refresh. Keep NSTask creation/cleanup unchanged.
- [ ] Run targeted tests to green; update docs with new real usage, no claimed Mac pass.
- [ ] Run native full suite, typecheck, lint, build, production, format and diff checks; commit.
- [ ] Parent independent review and exact-head Mac menu/quit/signature/identity checks before release.

## Execution Ledger

Base bcf5ef3. Parent approved the minimal design and inline TDD execution. No subagents spawned; parent supplies independent review.

- 10:05 UTC: Targeted VM/packaging 20/20; native full 348/348 and CLI 13/13; type/lint/build/production/format/diff gates passed. Lint first found one unnecessary optional chain in the test adapter; removed and type/lint/targeted suite rerun green. These are Linux/VM observations, not macOS menu execution evidence.
- Ruling: menu opening displays the last observed state/time without queuing status. Explicit refresh/open performs updates. This avoids disabling menu actions while native menu tracking might defer idle delivery; parent approved this adjustment.
- Pending: independent source review and final actual Mac menu/selector/lifecycle verification.
