# Selected-directory atomic no-clobber write: prototype gate

**Not product code.** The installer continues to use its current writer until this standalone prototype is independently reviewed and verified on the authorized Mac fixture. No sandbox changes, operational HOME writes, credentials, compilation, package dependencies, or global temporary directories.

## Why this is separate from the sandbox failure

The Foundation EPERM report is an environment limitation, not a production defect. Separately, `fileExistsAtPath` followed by an atomic replacement can overwrite a file created between those operations. Apple's atomic save contract permits replacing the original. This prototype tests atomic _new-file publication_, not a relaxation of write permission. It uses only the explicitly selected fixture parent, unlike granting access to an OS-wide TemporaryItems directory. The tradeoff is extra native/JXA ABI surface, so it cannot ship merely because injected tests pass.

## Exact candidate primitives

1. Accept an existing absolute selected parent, reject NUL/dot traversal, and a fixed safe basename (no slash). The caller still owns plugin identity/content checks. Open only the existing parent with `open(path, O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW_ANY)`. No O_CREAT, no optional variadic mode argument. `O_NOFOLLOW_ANY` is essential: final-component O_NOFOLLOW or canonical prechecks alone do not protect intermediate components. Unsupported flags/OS fail closed; no weaker fallback. The two fixed arguments/no-vararg call still needs actual ARM64 JXA validation.
2. Bind **fixed signature** `int mkostempsat_np(int,char*,int,int)`. Hold a NUL-terminated mutable NSData template `.sticker-write.XXXXXXXXXXXX`; pass its mutableBytes, suffix length0, O_CLOEXEC. Read the returned mutation from that buffer, require exact prefix/alphanumeric suffix and no slash/NUL other than terminator. Apple's implementation uses openat with O_CREAT|O_EXCL|O_RDWR and0600 internally; the variadic call stays inside native libc, not JXA.
3. Wrap returned fd with NSFileHandle initWithFileDescriptor:closeOnDealloc:NO, write bounded UTF8 NSData via writeData:error:, check success and final offset equals byte count. Then fixed-signature fsync(fd), close(fd). Treat errors/unsupported selector/bridge nil/uncertain close as failure; never publish partial data. Do not retry close, which could act on a reused descriptor. FileHandle does not own final close.
4. Publish the verified temp basename to the fixed destination using `int renameatx_np(int,const char*,int,const char*,unsigned int)` with the **same pinned parent fd** and RENAME_EXCL. Existing destination of any type => conflict, never remove/replace it. Unsupported filesystem/EXDEV/permission failure => unverified, no ordinary rename/copy fallback. Directory fsync after publish is a separate durability result; failure must not trigger destination rollback/removal.
5. On failure remove only the generated temp basename created by this invocation using `unlinkat(parentFd,name,0)`; close only owned descriptors exactly once. Never scan/delete other temporary files and never delete destination. Cleanup failure is explicitly unverified. Publish success disables temp cleanup. No arbitrary or user-supplied temp basename.

## Bounds and residual limits

At most one <=2MiB fixed payload, one parent and one temp fd. Kernel filesystem calls can block; native process supervision remains the outer time bound. No guarantee against all malicious same-UID processes: they can modify owned files later or move an owned directory. Pinned descriptor prevents pathname redirection after opening; no-follow prevents symlink traversal while opening. Directory rename after fd capture must not redirect writes to the new path occupant; a future product integration must honestly detect/report disappeared published paths. Atomic visibility/no-clobber is not unconditional power-loss durability. ACLs, read-only/network/non-supporting filesystems and sandbox policies may still deny the operation.

## Evidence and tests before product adoption

- Reproduce the current actual-source check/use contract with an injected atomic writer that creates a competing file after the absent check; show overwrite. Label this a deterministic source/API-contract reproduction, not an actual Mac race.
- Injected candidate tests: complete publication, pre-existing regular/symlink/directory destination, competitor appearing immediately before publish, intermediate symlink refusal, short/incomplete write, fsync failure, close uncertainty, unsupported rename, temp cleanup failure, descriptor close counts. No secrets in diagnostics.
- Actual Mac standalone probe, selected empty private fixture only: print binding availability, mutated buffer/name validity, successful exact UTF8 bytes and0600, then duplicate target remains byte-identical, symlink target remains unchanged, no leftover owned temp after controlled failures. Verify same fd and no global TemporaryItems access under the unchanged sandbox. Actual architecture/OS/filesystem recorded by parent, no assumptions.
- Independent review of this fixture and tests precedes Mac handoff. Only after exact native probe success decide whether to substitute the product writer and rerun the original GUI. Production writer/ZIP unchanged during prototype work.

## Primary sources

- https://developer.apple.com/documentation/foundation/nsdata
- https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/Articles/RaceConditions.html
- https://developer.apple.com/de/documentation/foundation/nsdata/writingoptions/withoutoverwriting (cannot combine with atomic)
- https://github.com/apple-oss-distributions/Libc/blob/main/include/unistd.h (fixed signature, macOS10.13+)
- https://github.com/apple-oss-distributions/Libc/blob/main/stdio/FreeBSD/mktemp.c (mkostempsat_np and O_CREAT|O_EXCL/0600)
- https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/open.2 (O_NOFOLLOW_ANY)
- https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/rename.2 (RENAME_EXCL and unsupported-filesystem refusal)
