# NSTask cwd launch boundary probe — isolated diagnosis only

Root cause is not established. Do not change product cwd/environment from this hypothesis. Confirmed product issue: initial Bash child stalled in getcwd/open before Docker fixture entry while direct CLI worked. This probe never calls Docker or product scripts.

On Mac, confirm osacompile `-s` stay-open support as for the quit probes. Build into a **new** parent-selected temporary path with `bash tests/fixtures/access-cwd-probe/build.sh /absolute/new/fixture`. The script only creates that fixture and compiles/ad-hoc verifies an app; it does not launch it. Begin under an ASCII temporary base. If needed, repeat under a newly selected temporary directory on the affected volume; never use the real project/data directory as a fixture.

Open CwdProbe.app. Click Run next case only after recording the previous result. Cases proceed manually in this order: ASCII true, Unicode true, ASCII Bash marker+exec pwd, Unicode Bash, symlink alias Bash, unspecified task cwd Bash, then explicitly sanitized ASCII/Unicode Bash. There is no automatic matrix execution. First timeout halts progression.

Trace records only fixed case IDs, cwd variant, sanitized flag, before/after cwd assignment, before/after launch, PID, fixed first stdout marker, and exit/cleanup status. No environment values, Docker config, credentials or arbitrary stderr are logged. Output files stay in the chosen fixture and contain only the fixed marker/pwd result under the intended commands. Inherited BASH_ENV/ENV/exported-function presence blocks an inherited Bash case rather than executing personal startup hooks. Sanitized cases remove these plus PWD/OLDPWD/CDPATH/SHELLOPTS/BASHOPTS/POSIXLY_CORRECT; this is diagnostic only, not a product change.

After 10 seconds without exit, the probe sends TERM **only to its own NSTask child**, which either runs true or exec-replaces itself with pwd (no service descendants). After 5 more seconds, a still-running child produces cleanup-unconfirmed-stop. It does not send KILL, killall or claim cleanup. The app retains the child and stops new cases. Record exact PID and trace; report if kernel-uninterruptible or further force cleanup is needed before taking additional action. Quit while a child remains active is deferred using the previously tested host lifecycle path; no caller error-number guarantee is asserted.

For the CLI control, the Mac operator uses the same fixture case cwd and exact executable/arguments:

```bash
# Substitute one selected fixture case path, then execute directly from that directory.
cd -- /absolute/fixture/ascii
/usr/bin/true
/bin/bash --noprofile --norc -c 'printf "STICKER_SHELL_ENTER\n"; exec /bin/pwd -P'
```

Do not execute the inherited Bash control if shell hook variables are present. Repeat only the corresponding failing case, with inherited vs sanitized environment as a separately recorded comparison. Record physical/Unicode/alias/unspecified task cwd and direct-CLI outcome independently. A first-marker absence locates the failure before shell command entry but does not establish why getcwd is blocked.

No local/prod security settings, user configuration, services, credentials or source files are changed. Delete only the chosen diagnostic directory after all its PIDs have actually exited; leave it for inspection if cleanup remains uncertain.
