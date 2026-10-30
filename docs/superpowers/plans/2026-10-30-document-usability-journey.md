# STK72 document usability journey test plan

> **For agentic workers:** Use executing-plans for this test-only slice; independent review before publication.

**Goal:** Observe one existing planning-document workflow across versioned API data and user UI, without adding product features.
**Architecture:** Shared synthetic HTTP fixture journey creates v1, pins it to an issue, updates v2, retries identical operations and checks stale revision409. A Node integration test validates the setup against a scoped agent. A hosted Playwright spec consumes the same setup through owner fixture API and exercises pinned/current history, Back/Forward, cancel and keyboard at desktop/375px.
**Spec:** Canonical STK-72 bounded journey: HTTP-authored document v1 → exact issue pin → v2 → UI history/Back/Forward → limited keyboard navigation and 375px/CSS zoom2 layout checks.
**Tech:** Existing Node test runner, fetch fixture, Playwright. No dependencies.

## Decisions and constraints

- API setup rather than adding a second MCP child: existing actual MCP evidence is separate; these tests must say HTTP API, not MCP discovery.
- No production source changes; no real account, Mac UI, permissions or OS-blocked local Chromium retries.
- 200% CSS zoom is a layout stress proxy, not true browser chrome zoom, Safari, VoiceOver or human usability research.
- No invented defect or forced RED product mutation. Test setup is written before helper; failures from missing helper are harness development, not product regressions. Existing correct behavior may pass immediately.

## Review focus

Exact v1 content remains pinned after v2; idempotent retry does not add versions; stale write does not overwrite; Back/Forward identifies the actual historical URL; cancel has no writes; visible focused controls and no horizontal clipping under the stated viewport/zoom proxy.

## Tasks

- [ ] Add test-first shared HTTP journey and scoped-agent Node integration assertion, run it against isolated fixture.
- [ ] Add browser journey with existing role/label controls, literal source checks, history navigation, clean edit cancel, explicit keyboard traversal, 375px and CSS zoom2 layout assertions/screenshots.
- [ ] Run focused Node, existing DOM resources, test discovery/static/type/lint/build/full suite. Do not launch local browser.
- [ ] Independent review and coordinator publication for actual hosted browser run. Any true failure gets exact reproduction before product fixes; no browser success until hosted execution.

## Execution record

- Shared fixture and Node integration test written before helper. Initial missing-helper error was a harness setup failure, not a product defect or a product RED claim. No production code was changed.
- Scoped-agent HTTP integration passes; readonly and other-project write denial checked. Existing document DOM regressions plus new HTTP test:11/11.
- Full Node suite352/352 + CLI13/13, build, lint, typecheck passed. Initial lint caught redundant narrowing; corrected test helper only. Existing npm environment/version notices and Vite Zod annotation warnings are not hidden.
- Playwright discovery lists desktop+iphone cases; actual browser execution remains hosted-only because local OS launch is blocked. No alternate launch flags attempted.
- Keyboard assertions cover activation, one Tab/Shift-Tab pair, Escape and return focus; not an exhaustive focus-trap or assistive-technology audit.
- Independent review checked three test sources, actual scopedHTTP pass, route/version semantics; removed an environment-specific path from this plan.
