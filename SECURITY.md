# Security policy

Please report vulnerabilities privately via GitHub **Security → Report a vulnerability**
on this repository rather than opening a public issue. We aim to respond within 7 days.

Deployment notes:

- Set `THWX_ADMIN_TOKEN` in every public deployment; without it the `POST` endpoints are open.
- Restrict `THWX_CORS_ORIGINS` to your web origins in production.
- The container runs as a non-root user and only needs outbound HTTPS to the forecast provider.
