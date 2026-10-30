# Dedicated Sticker Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse one native Sticker window without reloading user work on Dock activation.

**Architecture:** Foundation-only access contracts and lifecycle decisions feed an AppKit/WebKit controller. Existing shell control remains the sole Docker mutation path; the native window uses status instead of invoking the browser-opening command. Installation compiles/signs the native sources into the existing owned app contract.

**Tech Stack:** Swift 5 language mode, installed Swift >=5.7/macOS SDK >=11.3, Foundation/AppKit/WebKit, Bash, existing Node tests.

**Spec:** docs/superpowers/specs/2026-10-30-dedicated-window-design.md

## Global Constraints

- Base af81491b0cb09e5109e5859a6bfad8ae7e54ad11; unmerged PR93/99/101 excluded.
- No new dependencies, OS grants, entitlements, signing credentials or production replacement.
- Browser dispatch is intercepted in fixtures; Docker is always mocked in native testing.
- New build/cache data stays on eyedisk; small native UI fixture may use private system tmp.

## Review Focus

- Download file appearing after selection must survive unchanged (Task 2 native race test).
- Pending file/dialog callback completes exactly once on quit, with no stranded app (Task 2).
- Existing page and draft survive stopped service and subsequent recovery (Task 2).
- Simultaneous or repeated app activation does not create a second working window (Task 2).
- Tampered manifest, origin/context changes, existing app ownership and signing failures fail closed (Tasks 1, 3).

### Task 1: Foundation contracts and lifecycle

**Files:** packaging/macos/AccessCore.swift; tests/native/access-core.swift; tests/native/run-access-core.sh.
**Interfaces:** AccessSnapshot.parse(Data) -> AccessSnapshot?; Installation.load(resources: URL) -> Installation; WindowState.open(readyOrigin: URL?) -> WindowAction; NavigationPolicy.classify(URL, origin: URL, explicit: Bool, mainFrame: Bool) -> NavigationChoice.

- [ ] Write assertions for malformed/oversized/state-inconsistent status, exact loopback origins, manifest pinning, first load/focus/retry/origin-change and busy quit.
- [ ] Run native tests RED; implement minimal contracts; rerun GREEN.
- [ ] Commit contracts and tests.

### Task 2: AppKit/WebKit controller and native proof

**Files:** packaging/macos/StickerApp.swift, packaging/macos/Main.swift; tests/native/dedicated-window/*.
**Interfaces:** StickerApp(configuration: Installation, externalOpener: (URL) -> Void) owns window, menu, Process and panel lifetimes; production entry loads installation from Bundle.main.

- [ ] Add native fixture assertions for first load/reopen identity, Save/Cancel/race, panel quit, server failure/recovery and duplicate launch.
- [ ] Observe failing gates against the old browser launcher; implement typed delegates and once-only callback/panel cancellation.
- [ ] Run synthetic native scenarios, record actual outcomes and exact hashes; repair ordinary failures through RED/GREEN.
- [ ] Commit only after required native gates pass; unresolved security/data-loss gates remain blockers.

### Task 3: Installation and integration regression

**Files:** scripts/install-access.sh; tests/access-packaging.test.ts; tests/access-runtime.test.mjs; docs/ACCESS.md; README.md.
**Interfaces:** existing --mac target contract unchanged; existing manifest/bundle identity preserved; runtime status/start/stop CLI unchanged.

- [ ] Write failing compile/prerequisite/strict-sign and owned reinstall fixtures; ensure native test open and xdg-open cannot reach the user browser.
- [ ] Compile native app with explicit installed-toolchain preflight; retain transactional install and identity guard; document prerequisites.
- [ ] Run full test/CLI/type/lint/format/build/production and native regression, inspect evidence.
- [ ] Commit; request fresh independent review of full range; fix important findings with regression tests; return exact commit/tree and draft review route without deploying.
