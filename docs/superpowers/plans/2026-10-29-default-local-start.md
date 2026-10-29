# Standard passwordless local installation

User requested passwordless access as the default, not an extra mode toggle. The authorized standard path is a verified local Docker deployment, not unauthenticated remote access.

- Compose/raw Node defaults remain password-authenticated and fail closed without a password.
- `scripts/start.sh` selects trusted local owner access for its invocation and delegates all resolved Compose/actual publication checks to the existing verifier. Shell/.env mode values are overridden intentionally; existing COMPOSE_FILE and agent mounts remain selected. The launcher does not directly parse, print or edit credential files; Compose and the app retain their existing explicit configuration loading.
- Existing running services are never implicitly stopped/reconfigured. Updates are backup, explicit stop, verified start.
- Keep request Host/Origin/CSRF/proxy checks and separate bearer authentication. Preserve owner-only MCP settings and exact safe directory response.
- README, environment example and install/restore instructions use the standard entry point and explain same-machine trust and raw/remote password setup.
- Mock launcher regression verifies default selection, no password, optional Compose selection and failure/cleanup boundaries. Real Docker lifecycle invokes this default entry point at an actual nondefault published port; hosted browser verifies password-free UI. Local native tests are not substituted for hosted evidence.
