# Mac quit dispatch diagnostic — not product code

Use only a temporary Mac directory. No Docker command, production install, credential, service, or user data is accessed. The only task is `dummy.sh`, which writes markers and waits for its own `release-gate` file.

1. Read the actual Mac `man osacompile` and `/usr/bin/osacompile -h` (the archived web manual was unavailable), and confirm this version uses `-s` for a stay-open applet. If not, stop and report the actual option; do not infer it from successful plain compilation.
2. From this checkout run `bash tests/fixtures/access-quit-probe/build.sh "$TMPDIR/sticker-quit-probe-UNIQUE"` with a **new absolute path**. This only builds and ad-hoc verifies A/Probe.app and B/Probe.app. It does not launch either app.
3. Launch **one app at a time**, record its exact PID/bundle path, and use that selected app for normal OS Quit/Cmd-Q. Avoid matching another app by a shared generic name. Trace is `<base>/A/trace.log` or `B/trace.log`.

## A: current product run/modal structure, instrumented

Only `run-enter` and first-line `quit-enter` tracing is added to the current product source. Its selected installation is a temporary dummy fixture, not a real project. Initial status is a static known JSON with no URL.

- In the selection dialog, send normal OS quit. Record whether `quit-enter` appears and whether the PID exits. No trace means the handler was not dispatched; direct function unit-test success does not answer this question.
- Fresh process, choose 서비스 시작. After `A/task-started` appears, send OS quit and inspect trace **before** releasing the gate. Then `touch <base>/A/release-gate` and observe task-completed/PID/trace. Do not kill the dummy while diagnosing dispatch.

## B: nonmodal stay-open prototype

`run` creates the native window and returns. Buttons only queue requests and return. `idle` launches/checks the dummy once, cleans up when complete, and returns 1. There is no synchronous dialog, JavaScript while loop, or waitUntilExit. Keep a sufficient observation window for the host's first idle event; record actual timing rather than calling a delayed first idle a failure.

Expected idle case:

```
run-enter
run-return
idle-enter
idle-return
quit-enter
exit-idle
```

Expected busy case: click Start dummy task and wait for `B/task-started`; send OS quit. Expected `quit-enter`, `quit-deferred` while the task remains alive. Release with `touch <base>/B/release-gate`; expected `task-complete`, `task-cleanup`, `exit-after-task` and only the probe PID exits. Record whether the button callback, idle handler, and quit handler are each reached.

Test the native Quit probe button separately from OS quit; they are different dispatch paths. Capture the nonmodal window and timestamps. If bridge/class/selector dispatch fails, report the original local error and exact phase; do not change product code yet.

After each run, reset only that fixture's gate/marker files before starting a fresh process. Once probes and dummy tasks have exited, remove only the explicitly created temporary fixture directory. Do not send killall, stop Docker, modify login items, or install this diagnostic in Applications.

## C: experimental cancellation reply (not a product fix)

C keeps the proven B nonmodal/idle structure and existing applet delegate. Only internal button handling and OS quit handling are separated: internal requests set `quitRequested`; busy OS quit throws an Error with `errorNumber = -128`. The generic AppleEvent user-cancellation meaning is documented, but JXA propagation of this property is **not verified**. B's ordinary return already proved insufficient on the test Mac.

Official context: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/Lifecycle.html (userCanceledErr -128). This does not establish JXA Error-property mapping or applet-specific cancellation semantics.

- Record the exact OS caller error number/reply; do not treat a generic error as proof of -128 propagation.
- Idle OS quit should reach `quit-enter`, `request-quit`, `exit-idle` and exit only C.
- Busy OS quit should reach `quit-enter`, `quit-cancel-128`; **before gate release** require parent PID and dummy task alive, ongoing idle traces, and no unexpected modal error alert. If the PID exits, idle stalls or a dialog blocks it, the hypothesis failed.
- Release C/release-gate only after these observations. Require `task-complete`, `task-cleanup`, `exit-after-task` and eventual parent exit. Never infer cleanup merely from PID disappearance.
- Fresh process, repeat busy quit using the internal button. It must use `request-quit`, `quit-deferred`, not throw from idle. Observe completion/cleanup/exit after gate release.

Node VM tests cover only the requested branch/error object's structure. Actual AppleEvent propagation, event-loop continuity and task survival require Mac evidence. Product controller remains unchanged until a verified result and independent review.
