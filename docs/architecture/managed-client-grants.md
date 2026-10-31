# Managed client grants: server foundation

This increment supplies scoped server grant persistence and authentication. One-click native connection, secure secret storage, peer confirmation, durable host journal and certified client configuration writers are separate, unfinished gates. No `sticker_client_apply` tool is shipped by this increment. Ordinary users must not be asked for custom JSON, paths or token fields by the future Connect UI.

The future native Connect flow generates its secret privately after an explicit current-project grant decision, submits only SHA256 of the UTF8 Bearer string to the server, proves the provisional identity, then revalidates native confirmation/configuration before activation. Server owner authentication authorizes only the server grant; owner session, Origin or a native-looking header cannot authorize host control. Normal Bearer authentication necessarily sends the secret only in Authorization. Server responses, errors, operations, audit and MCP arguments never return it or its verifier. Protected SQLite backups contain private verifier data.

Schema11 retains configured static agents unchanged and stores managed identities separately. Each grant has exactly one existing project and a fixed client/installation/connection binding. Provision requires a current owner, configured Origin, strict JSON, confirmation, operation ID, approval digest and plan deadline within five minutes. Activation requires the original binding, operation and revision while both grant and plan are fresh. Cleanup revoke requires current owner and revision, and can complete after plan expiry. Phase replay returns the old safe receipt **and current effective state**; a receipt cannot reactivate a revoked/expired/restored grant. Retained IDs and verifiers cannot be reassigned. Total live static and managed capacity is100.

Provisional admission permits only exact GET `/api/session` and `/api/client-grants/self/verify`. Ordinary reads, uploads and writes are denied before domain handlers; active grants use their single project and requested write permission. Every Bearer admission consults the live registry. Invalid, revoked or expired Bearer never falls back to owner authentication. Committed revocation applies at the next admission; requests already admitted may finish. Ordinary restart preserves active managed grants; owner sessions retain their existing in-memory lifetime.

Private bootstrap routes, pending the future host adapter:

| Route                                            | Server authority                                 |
| ------------------------------------------------ | ------------------------------------------------ |
| POST `/api/client-grants`                        | Owner; private hash-only provision body          |
| POST `/api/client-grants/:id/activate`           | Owner; exact original binding and CAS            |
| POST `/api/client-grants/:id/revoke`             | Owner; managed grant and CAS                     |
| GET `/api/client-grants/operations/:operationId` | Owner; safe phase receipts and current state     |
| GET `/api/client-grants/self/verify`             | Managed Bearer; its safe identity and scope only |

These routes are named pending MCP transport exceptions, not implemented host tools. Static initialize/tools metadata does not grant domain authority. Provisional help reports `activation_required`; capabilities still fails on the nonexempt maintenance request. Maintenance admits/drains these routes normally. A503 during revoke or readback means cleanup pending; it is not proof of revocation or permission to discard a recovery secret.

Project deletion revokes managed grants in the same transaction while preserving historical project identity. Backup validation remains query-only. The explicit restore script validates an extracted stage, invokes the fixed `client-grants-restore` action, commits terminal revocation and revision advances, closes and revalidates, then replaces data. Any failure stops before replacement and leaves service stopped. Pre11 stages are not upgraded by this action; future schemas are rejected. No normal-startup invalidation, host path HTTP API, config editor, secret escrow or automatic owner escalation is introduced. Credential-free archive profiles require their own explicit schema review and are not widened by this registry migration.
