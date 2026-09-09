# Web.de Access — Current Status

_Last verified: 2026-09-09_

## Current source state

- Version 0.2.9: the MCP handshake now reads the package version instead of reporting a stale hardcoded value.
- Version 0.2.9: refreshed the mail-library dependencies and vulnerable URI/HTTP dependency pins after the production audit reported eight advisories. Direct dependency major versions are unchanged. Offline MIME composition/parsing passes, and the fresh production audit reports zero vulnerabilities.
- The source release is `v0.2.9`.
- `package.json`, `package-lock.json`, and the three provider manifests use
  version `0.2.9`.
- The lockfile uses `@modelcontextprotocol/sdk` `^1.30.0` and scoped overrides
  for its vulnerable transitive packages. A fresh production audit reports zero
  vulnerabilities.
- Credentials remain outside the repository in the operating-system credential
  store. The server fails closed for legacy password environment variables and
  plugin-local `.env` credentials.

## Verification commands

| Command | Verifies |
| --- | --- |
| `npm run check` | MCP server syntax |
| `npm test` | 15 offline security, configuration, manifest, MCP-handshake, mail-library, and public-safety tests |
| `npm run security:scan` | No legacy credential files or unexpected secret references |
| `npm audit --omit=dev --audit-level=high` | Production dependency advisory gate |

`.github/workflows/ci.yml` runs the offline checks above on Windows for every
push and pull request. It deliberately uses `npm ci --ignore-scripts` and does
not execute live mailbox operations.

## Maintenance boundaries

- `npm run smoke` uses stored credentials and touches a real mailbox; run it
  only with an authorized profile.
- `npm run e2e:email` sends a real message. It is excluded from CI and normal
  source maintenance.
- Keep provider manifests and their shared skill path in sync; tests enforce the
  current layout and secret-free public files.

## Next action

For a source or dependency change, run the verification commands above before
committing. A tag, GitHub release, marketplace publication, or client update is
a separate delivery decision.
