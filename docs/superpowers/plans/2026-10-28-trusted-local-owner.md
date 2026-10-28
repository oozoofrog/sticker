# Trusted local deployment owner mode

**Goal:** Default-off passwordless owner access for an explicitly trusted loopback-published Docker deployment.
**Supersedes:** Seven-day remembered-access proposal; no private auth store/token persistence is included.
**Authority:** User asked to remove password friction; coordinator approved code and isolated tests only, not operational activation.

## Boundary

Environment opt-in is an administrator trust declaration, NOT proof of host binding. A dedicated Docker start script validates resolved configuration and actual published ports. App enforces exact loopback canonical Host/Origin, rejects duplicate/malformed headers, proxy identity headers and cross-site fetches. Bearer authentication remains separate with no failed-token fallback. Same-host users/processes and administrator-attached container peers remain inside the trusted deployment boundary; direct unverified docker starts or later port changes defeat deployment assurance. No Tailnet/gateway/proxy support in this mode.

## Plan

- [ ] Pure policy RED tests: off/invalid mode, canonical origin, Host/Origin duplicates/null/malformed, cross-site and proxy headers, mutation Origin requirement and bearer precedence.
- [ ] HTTP RED tests: password mode unchanged; opted-in bootstrap owner without password/token, no owner session issuance/logout fiction; agent remains agent and bad bearer401.
- [ ] Deployment validator/start-script RED tests: only127.0.0.1 TCP publication and matching canonical port; no hostnetwork/extra ports; inspect mismatch fails. Never stop a pre-existing service on a validation failure.
- [ ] Concise read-only mode UI on desktop/mobile; no password login screen in verified mode, no misleading logout.
- [ ] Exact full gates and independent security review before parent publication. No live activation or Mac changes by worker.
