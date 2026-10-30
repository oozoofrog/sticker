# Native dedicated-window regression

Synthetic fixtures only. Never point these tests at production Sticker, user
credentials or browser tabs. Large compiler caches stay in an explicit output
folder. The native UI fixture uses a private `/private/tmp/sticker-native-*`
folder, a loopback synthetic server and a mocked status/start/stop script.
No Docker or real browser opener is invoked.

Required gates: initial load and repeated open retain document/draft/route/scroll;
close/minimize/reopen reuse one window; duplicate application launch focuses the
first instance; native alert/confirm and file-panel callbacks resolve once on
cancel/quit; first-load failure can be retried while an existing document is never
silently reloaded by recovery; Save creates exact bytes, cancellation creates no
file, existing and racing destinations remain unchanged; redirects are denied;
owned service child completes and is reaped before deferred exit.

Stop on a new permission prompt or user input interruption. Preserve evidence.
A native test pass is not an authorization to replace the installed app.
