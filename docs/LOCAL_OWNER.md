# Trusted local owner mode

Raw server/Compose authentication is unchanged: an operator-chosen owner password and a 12-hour in-memory session. `LOCAL_OWNER_MODE=off` is the default. No remembered-device credentials or private authentication database are added by this feature.

## Explicit trust boundary

`LOCAL_OWNER_MODE=trusted-loopback` is an **administrator deployment trust declaration**, not an application proof that Docker published only to loopback. In this mode a request without an Authorization header can act as owner without a password or cookie. Every local OS user/process able to contact that publication is therefore trusted as owner. This is unsuitable for shared/untrusted machines. No password, token, long-lived credential or identity is inferred from Tailscale membership, IP headers or proxy identity headers.

The app requires an HTTP canonical `APP_ORIGIN` using `localhost` or `127.0.0.1`. Passwordless owner requests must have its exact Host and port. Provided Origin must match exactly, including GET; state-changing owner requests require Origin. Cross-site fetch indications, duplicate boundary headers, Forwarded/X-Forwarded/Tailscale proxy headers are rejected. A present Authorization header always takes the separate agent authentication path: empty, malformed and invalid credentials never fall back to owner. Valid agent credentials can use their existing internal MCP host/port and remain scoped agents, not owners.

The app cannot prevent an administrator bypassing the verified start script, publishing externally afterward, or attaching a hostile peer container to its network. A non-browser network client can forge Host/Origin. These are **not** cryptographically authenticated local identity checks. No Tailnet proxy, Serve/Funnel or gateway configuration is provided or activated.

## Standard local installation

The standard installation command is `bash scripts/start.sh`: no password setup or mode toggle is needed. Choosing this local installation trusts the same-machine users/processes described above. The launcher explicitly exports `LOCAL_OWNER_MODE=trusted-loopback` for this invocation, overriding shell and `.env` mode choices without editing either. It preserves `COMPOSE_FILE` and optional agent mounts. Raw startup remains password-based and refuses missing/weak passwords. Code verification is not proof of operational activation.

Keep a matching loopback `APP_ORIGIN` and loopback-only compose publication. In this mode OWNER_PASSWORD may be empty; outside this mode the server still rejects missing/weak passwords. Use `bash scripts/start.sh` from a stopped installation (`start-local-owner.sh` remains the lower-level explicitly configured verifier). It builds the existing image, validates resolved compose metadata in a no-published-port validation container, starts only Sticker, then inspects actual publication. Validation permits only TCP8787 published to127.0.0.1 at the canonical port. Extra publications and custom network_mode are refused. A running pre-existing service is refused without stopping/reconfiguring it. A failed post-start inspection stops only the target this invocation explicitly started. Do not run concurrent start/deployment operations.

The authenticated UI identifies `로컬 소유자` rather than offering a misleading logout: access is determined by the deployment mode, not a browser cookie. To end passwordless access, explicitly stop the deployment, restore password mode and a unique owner password, then use raw Compose startup rather than the local launcher. No mode changes are performed from the app.

Project backup/restore does not carry an authentication grant; local-owner access remains an external operator deployment setting. Default password sessions still disappear on restart. Docker exposure must be reviewed again after configuration changes or restoration onto another host.

## Docker Server support boundary

Verified local startup requires a stable **Docker Server Engine 28.3.3 or newer**, not merely a recent CLI. The launcher queries `docker version --format '{{.Server.Version}}'` before build/start/stop mutations. A failed query, unknown result, prerelease, vendor suffix, leading-zero component or non-numeric version is refused rather than guessed safe. Only canonical `major.minor.patch` components (0–999) are accepted. Older engines remain usable only through separately configured password-authenticated startup; the launcher does not upgrade Docker automatically.

Docker documents [localhost publication leakage before 28.0.0](https://docs.docker.com/engine/network/port-publishing/) and a [28.3.3 fix for loopback publication after firewalld reload](https://docs.docker.com/engine/release-notes/28/). Version gating does not prove arbitrary host firewall/network configuration safe, and these upstream notes are not a vulnerability finding about any particular user's Mac. Host publication inspection and request restrictions remain required.

“Same machine” and the local browser URL assume a local Engine/Desktop context on the current computer. The launcher preserves the selected Docker context and `DOCKER_HOST`; it never silently switches them. For a remote daemon, loopback publication and trusted local users/processes refer to that Docker host, not the CLI computer, and local browser reachability is not guaranteed.
