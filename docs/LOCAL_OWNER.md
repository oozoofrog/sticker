# Trusted local owner mode

Default authentication is unchanged: an operator-chosen owner password and a 12-hour in-memory session. `LOCAL_OWNER_MODE=off` is the default. No remembered-device credentials or private authentication database are added by this feature.

## Explicit trust boundary

`LOCAL_OWNER_MODE=trusted-loopback` is an **administrator deployment trust declaration**, not an application proof that Docker published only to loopback. In this mode a request without an Authorization header can act as owner without a password or cookie. Every local OS user/process able to contact that publication is therefore trusted as owner. This is unsuitable for shared/untrusted machines. No password, token, long-lived credential or identity is inferred from Tailscale membership, IP headers or proxy identity headers.

The app requires an HTTP canonical `APP_ORIGIN` using `localhost` or `127.0.0.1`. Passwordless owner requests must have its exact Host and port. Provided Origin must match exactly, including GET; state-changing owner requests require Origin. Cross-site fetch indications, duplicate boundary headers, Forwarded/X-Forwarded/Tailscale proxy headers are rejected. A present Authorization header always takes the separate agent authentication path: empty, malformed and invalid credentials never fall back to owner. Valid agent credentials can use their existing internal MCP host/port and remain scoped agents, not owners.

The app cannot prevent an administrator bypassing the verified start script, publishing externally afterward, or attaching a hostile peer container to its network. A non-browser network client can forge Host/Origin. These are **not** cryptographically authenticated local identity checks. No Tailnet proxy, Serve/Funnel or gateway configuration is provided or activated.

## Reviewed activation only

Before enabling this on a real installation, obtain the owner's explicit acceptance of the local-user/process and deployment risks above. Code tests do not constitute operational approval. No script edits `.env` or enables this mode automatically.

After that approval, configure `LOCAL_OWNER_MODE=trusted-loopback`, a matching loopback `APP_ORIGIN`, and loopback-only compose publication. In this mode OWNER_PASSWORD may be empty; outside this mode the server still rejects missing/weak passwords. Use `bash scripts/start-local-owner.sh` from a stopped installation. It builds the existing image, validates resolved compose metadata in a no-published-port validation container, starts only Sticker, then inspects actual publication. Validation permits only TCP8787 published to127.0.0.1 at the canonical port. Extra publications and custom network_mode are refused. A running pre-existing service is refused without stopping/reconfiguring it. A failed post-start inspection stops only the target this invocation explicitly started. Do not run concurrent start/deployment operations.

The authenticated UI identifies `로컬 소유자` rather than offering a misleading logout: access is determined by the deployment mode, not a browser cookie. To end passwordless access, explicitly stop the deployment, restore password mode and a unique owner password, then restart. No mode changes are performed from the app.

Project backup/restore does not carry an authentication grant; local-owner access remains an external operator deployment setting. Default password sessions still disappear on restart. Docker exposure must be reviewed again after configuration changes or restoration onto another host.
