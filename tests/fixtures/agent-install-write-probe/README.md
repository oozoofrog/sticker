# Native write prototype — not the installer

Review DESIGN.md first. These files are **not included in the download ZIP** and do not change the product writer. Only the authorized Mac operator runs this prototype after independent source review. No operational Codex home, configuration or plugin is touched. No sandbox setting is changed.

Use a newly created, selected, private **real-path** directory (mode0700, owned by the operator), containing only `.sticker-write-probe` with exact text `synthetic-write-probe-v1` followed by LF. Do not use a real plugin directory. Existing directories with other entries are refused. The script leaves fixed synthetic output files for inspection; it does not delete the fixture.

Materialize the reviewed source at an exact Git commit. Concatenate `candidate.js`, `native.jxa`, `probe.jxa`, in that order, into a file **inside the already approved fixture**. Invoke `/usr/bin/osascript -l JavaScript <combined-file> <fresh-child-fixture-realpath>` under the existing unchanged policy. The combined file must be outside that fresh child because the child must initially contain only the marker. The parent controls allowed paths; this fixture creates none outside the explicit child and does not request broader global temporary-directory permissions.

One JSON result distinguishes new-file publication, exact UTF8 bytes,0600, existing regular-file/directory/symlink conflict preservation, intermediate-symlink refusal, and absence of owned temporary remnants. Any binding/OS/filesystem error is unverified, not success. Do not retry with a less restrictive policy or ordinary overwrite fallback. `published_unverified` means the destination exists but a later durability/cleanup step was not verified; never remove that destination as rollback.

This first native probe establishes primitive behavior only. Follow-up authorized fixture cases must still exercise parent rename after fd capture, unsupported/denied publication, and process cleanup before considering production substitution. Mock tests are not native ABI evidence. No need for Node, Python, compiler or additional packages on the Mac.
