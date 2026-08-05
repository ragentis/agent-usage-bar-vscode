# Security

## Reporting a vulnerability

Report a suspected vulnerability privately to the repository owner before opening a public issue. Do not include credentials, agent session transcripts from either provider, or private filesystem paths in a report.

## Supported versions

Only the latest release is supported. Fixes ship in a new version rather than as patches to an older one.

## Scope

The extension has no telemetry, no owned service, and no runtime dependencies. It touches exactly two things outside itself, both to answer "how much of my plan is left":

- It launches the Codex CLI directly, never through a shell, and speaks that CLI's own JSON-RPC protocol. Codex keeps custody of its credentials.
- It sends the OAuth token Claude Code already stores to `https://api.anthropic.com/api/oauth/usage`, read only. The token is never logged, cached, written back, or refreshed.

No prompt, source code, or file content is transmitted anywhere. The extension writes no files of its own: the only thing it persists is your own settings, through the VS Code settings API, when you toggle a provider from its menu.

The full boundary is described under [Data access](README.md#data-access) in the README. Part of it is enforced mechanically rather than only stated: `npm run audit:bundle` fails the build on a runtime dependency, on bundled code from outside `src/`, on a network target other than the one allowed endpoint, on a shell execution, on a filesystem write, on the Codex credential path, and on any keychain verb that would change what is stored. See [The bundle audit](CONTRIBUTING.md#the-bundle-audit).
