# Security

## Reporting a vulnerability

Report a suspected vulnerability privately to the repository owner before opening a public issue. Do not include credentials, agent session transcripts from either provider, or private filesystem paths in a report.

## Supported versions

Only the latest release is supported. Fixes ship in a new version rather than as patches to an older one.

## Scope

The extension has no telemetry, no owned service, and no runtime dependencies. It touches exactly three things outside itself, all to answer "how much of my plan is left":

- It launches the Codex CLI directly, never through a shell, and speaks that CLI's own JSON-RPC protocol. Codex keeps custody of its credentials.
- It sends the OAuth token Claude Code already stores to `https://api.anthropic.com/api/oauth/usage`, read only. The token is never logged, cached, written back, or refreshed.
- It reads the session transcripts both agents write under `~/.codex/sessions` and `~/.claude/projects`, to count how much was spent on each day. These files contain prompts and source code, so only two things are taken from a parsed line: the recorded rate-limit percentage and timestamp for Codex, and the recorded token counts, message id, and timestamp for Claude Code. Nothing else is read out, and no message, path, or file content is kept. Setting `agentUsageBar.showHistory` to `false` stops these files from being opened at all.

No prompt, source code, or file content is transmitted anywhere, and every file the extension opens is opened read only. It writes no files of its own. Through VS Code's own storage APIs it persists your settings, the last usage reading, and one number per calendar day per provider.

The full boundary is described under [Data access](README.md#data-access) in the README. Part of it is enforced mechanically rather than only stated: `npm run audit:bundle` fails the build on a runtime dependency, on bundled code from outside `src/`, on a network target other than the one allowed endpoint, on a shell execution, on a filesystem write, on the Codex credential path, and on any keychain verb that would change what is stored. See [The bundle audit](CONTRIBUTING.md#the-bundle-audit).
