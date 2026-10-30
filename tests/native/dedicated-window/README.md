# STK-71: dedicated-window feasibility fixture

**NOT product code. NOT installed Sticker. Native behavior remains unverified.**
Canonical issue: STK-71 (`6e798a72-291b-465a-9dc6-162e162e0cbe`).

This standalone stay-open JXA app tests the documented AppKit/WebKit bridge before
changing the real launcher. It uses a nonpersistent website data store, a synthetic
loopback HTTP server and one app-owned window. No production URL, database,
credentials, browser tabs/history, browser scripting, login item or JS/native
message handler is used. No C/ABI helpers are present. Only its explicit fixture
folder is read/written; file selection is restricted to `upload.txt` and download
selection to a new `download.txt` inside that folder.

## Gate and scheduling

The parent Mac coordinator owns all native UI actions. Do not run concurrently
with ongoing user work or another Mac worker. Wait for its explicit scheduling.
The synthetic HTTP page has self-only connection/frame policy and fixture-only inline script/style permission. This does not establish a universal browser-network sandbox.

Stop immediately on callback type/bridge failure, missing trace, unexpected
permission prompt, an unintended navigation, frozen UI, or output outside the
fixture. Preserve evidence and report which actions were **not reached**. Do not
change privacy settings, widen sandbox permissions, add C helpers, kill browsers,
or reroute through PR93. A syntax/VM pass is not native proof.

## Build and run (Mac worker only, exact reviewed commit)

Requires the already-supported Node >=24 plus macOS standard osacompile/plutil/
codesign. No dependency installation, production service change or live account.

1. `fixture=$(mktemp -d /private/tmp/sticker-window-XXXXXXXX)`; verify mode0700.
2. Run `node tests/native/dedicated-window/server.mjs "$fixture"` in a separately
   owned foreground session. Record its printed origin and PID. This binds only
   `127.0.0.1` on an OS-assigned port and creates exact synthetic files with0600.
3. `bash tests/native/dedicated-window/build.sh "$fixture"`. This compiles/signs a
   new `StickerWindowFixture.app` only. Existing target/evidence are never removed
   or replaced. Verify final strict signature and exact source commit/hash.
4. Launch only that fixture app through normal Launch Services. No production
   app replacement, permanent Dock pin or permissions change.

## Native checklist (record separately, never infer unrun rows)

- Initial load: trace `created`, `initial_navigation`, `navigation_completed`,
  `loaded`, `focus`; `/metrics` has `loads:1`. A native completion exception is a
  gate failure, not permission to cast pointers or retry via another API.
- Type draft text, choose `Set route #draft`, scroll. Click its actual Dock icon
  ten times, hide via X, reopen and minimize/reopen. Exactly one content window;
  same document UUID/draft/hash/scroll; load count remains1. Record app PID but do
  not assert WebKit subprocess count1.
- Confirm dialog: choose cancel/Esc then OK. Page reports `confirm false/true`;
  trace once completion per request. Alert completes. Sheets are asynchronous,
  never nested modal run loops.
- File input: cancel, then select only the generated `upload.txt`. Displayed bytes
  must equal `Sticker synthetic upload 한글\n`. An out-of-fixture selection is
  rejected and must not be read.
- Blob download: cancel first; no destination. Then save to `download.txt`; bytes
  must equal `Sticker synthetic download 한글\n`. Try again with same name and
  confirm any platform replacement prompt only on this disposable fixture file:
  fixture rejects existing path; original checksum unchanged. A check-to-write
  collision must fail via documented WebKit behavior; do not add a custom writer.
- Explicit external link yields `navigation_choice:external` and no WebView
  navigation. **Fixture intentionally does not open the browser**: this verifies
  policy eligibility only, not real external-dispatch integration.
- Automatic `/redirect` to example.com is blocked. External link in iframe is
  blocked. No external page should load. Fixture handles only same-origin main
  navigation; it does not claim WebKit's full subresource network isolation.
- Menu Quit opens native nonmodal confirm; cancel/Esc preserves draft. Confirm
  terminates only fixture. OS quit is recorded but currently normal immediate
  fixture quit; product busy-child/quit rules remain untouched and require later
  product regression. This fixture starts no Docker children.

Capture screenshot and trace/server logs; retain source hashes. If a failure occurs,
report first failure and stop follow-on interactions. Do not relabel a failed bridge
as an application/user-permission issue without evidence.

After normal app quit, Ctrl-C the owned server session. Preserve fixture evidence.
Do not remove unrelated processes or any real Sticker data.

## What is not proven here

Production menu integration, exact install identity, default cookie persistence,
external-browser dispatch, same-origin target=_blank routing, server recovery,
real resource upload/download and app quit with a running Docker child are later
product gates. Native `block` callback/lifetime compatibility is specifically what
this experiment is intended to establish; no native success is claimed yet.

## Official references

- [JXA ObjC bridge: blocks and subclassing](https://developer.apple.com/library/archive/releasenotes/InterapplicationCommunication/RN-JavaScriptForAutomation/Articles/OSX10-10.html)
- [WKWebView](https://developer.apple.com/documentation/webkit/wkwebview/)
- [WKUIDelegate](https://developer.apple.com/documentation/webkit/wkuidelegate)
- [WKNavigationDelegate](https://developer.apple.com/documentation/webkit/wknavigationdelegate)
- [WKDownload destination](<https://developer.apple.com/documentation/webkit/wkdownloaddelegate/download(_:decidedestinationusing:suggestedfilename:completionhandler:)>)

The documented WebKit destination must be a nonexistent file in an existing writable
directory. No silent overwrite or custom atomic publication is implemented here.

## Protocol-registration failure diagnostic (no UI)

The first native launch stopped with `protocol does not exist` before window creation.
That does not identify which protocol failed or prove the OS lacks WebKit support.
Run this bounded diagnostic once in a fresh process, before attempting another GUI launch:

```sh
/usr/bin/osascript -l JavaScript tests/native/dedicated-window/Protocols.jxa
```

It imports the same three frameworks, queries the four exact official protocol names
using Foundation `NSProtocolFromString`, and reports every runtime lookup. Unknown or
nil lookup stops before any subclass registration. Only if all four are present does
it register one empty, process-local subclass per protocol, stopping at the first error.
No window, file, network, app-control, custom C binding, or policy changes are involved.
Capture its JSON stdout and exit status; do not launch the GUI afterwards automatically.
`runtime_protocol_absent` means unavailable to that process after imports, not a proven
unsupported OS version. `jxa_registration_failed` with all runtime lookups true narrows
the failure to the JXA bridge registration path rather than an absent runtime protocol.
Even `registration_only_pass` proves neither callback support nor the full delegate.
An unverified Foundation result is a stop, not permission to bypass protocol declarations.

Official API references: [Foundation NSProtocolFromString](<https://developer.apple.com/documentation/foundation/nsprotocolfromstring(_:)>),
[WKNavigationDelegate](https://developer.apple.com/documentation/webkit/wknavigationdelegate),
[WKUIDelegate](https://developer.apple.com/documentation/webkit/wkuidelegate),
[WKDownloadDelegate](https://developer.apple.com/documentation/webkit/wkdownloaddelegate),
and [JXA Objective-C subclass registration](https://developer.apple.com/library/archive/releasenotes/InterapplicationCommunication/RN-JavaScriptForAutomation/Articles/OSX10-10.html).
