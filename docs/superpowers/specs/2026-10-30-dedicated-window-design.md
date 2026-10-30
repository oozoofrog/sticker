# STK-71 dedicated Sticker window

The user approved an address-bar-free dedicated window: Dock activation reuses the existing Sticker page without reloading drafts, route or scroll. A small menu bar retains service status/start/confirmed stop. App exit does not stop Docker. This is a local access shell around the existing Docker web app, not a replacement for its React/Express service.

## Approach and authority

Browser automation would require broader browser permissions and could disturb personal tabs; JXA WebKit delegate registration failed the native feasibility gate. The selected implementation uses installed Swift/AppKit/WebKit with compiler-checked delegates, one NSWindow/WKWebView and no JavaScript/native message bridge. The parent explicitly requested implementation now after reviewing the preparation and native evidence; no additional design approval round is required.

## Required behavior

- One app instance per installed bundle, one reusable content window, initial load followed by focus-only reopen. Close hides; minimize/reopen preserves content.
- Preserve sticker-access-v2 manifest, bundle ID, exact Docker executable/context/project, sanitized Docker/Compose environment, asynchronous child ownership, explicit stop confirmation and strict final signing/reinstall ownership checks.
- Only a verified local loopback origin is loaded. Same-origin navigation stays in the window; explicit safe http(s) external links use the default browser. Automatic external navigation, popups, untrusted frames and download redirects fail closed.
- Show stopped/failed service with a small actionable status; retry/recovery must not silently reload a previously loaded draft. No automatic service startup.
- JS dialogs and file panels complete once; user cancellation is cancellation. OS/menu quit during a panel cancels that panel through its normal callback; busy service tasks finish and clean up before app termination.
- Downloads use WebKit to a user-selected nonexistent file, with no overwrite fallback. A native race test must prove an existing file is preserved after selection and before WebKit writes. If this contract fails, do not claim completion or add a custom writer.
- Explicit compiler prerequisite: installed Swift >=5.7 and macOS SDK >=11.3. No automatic developer-tool installation, new entitlement, Developer ID credential or policy modification.
- No PR93/99/101 code, production replacement, new auth/network grants or automatic Dock/login registration.

## Verification

Foundation core tests, actual Swift compilation/signing and mock-Docker install/reinstall tests, native WebKit tests for lifecycle/download/panel/recovery, full existing test/CLI/type/lint/build/production checks, and a fresh independent reviewer. Synthetic UI tests must prevent actual browser dispatch and never access production data.
