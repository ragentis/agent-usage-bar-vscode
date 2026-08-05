# Changelog

Notable changes to Agent Usage Bar. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-08-06

First release. Desktop VS Code on Windows, macOS, and Linux; developed and hand-tested on Windows, with the per-platform paths covered by tests on all three CI runners.

### Added

- Separate Claude Code and Codex status bar items, each drawn with its own mark.
- Compact and full display modes, and used or remaining percentages.
- Configurable warning and error color thresholds, based on the percentage already used.
- A click menu for toggling either provider, refreshing, and opening settings.
- Account-level readings, so usage spent on another machine or in another client still shows up.
- A refresh when a local agent writes, floored at one read per thirty seconds, plus a configurable background interval.
- One reading shared by every open window, so the cost of six windows is the cost of one and all of them show the same number.
- A history icon and a tooltip note once a reading is more than ten minutes old.
- A tooltip drawn with theme colors: a filled bar per window, dimmed detail lines, and refresh and settings links.
- A pace beside each window's reset time, off with `agentUsageBar.showPace`: the 5-hour window forecast to when it runs out or where it lands by the reset, the weekly one only clocked, since its hours run through nights and days off and a forecast across them would mislead.
- A `~` marker when a window has reset since the last reading, so a refilled quota never reads as full.
- An error color and a reason whenever a provider reports the account as stopped, however low the percentage is.

### Data access

- Claude Code usage is read from `https://api.anthropic.com/api/oauth/usage` with the token Claude Code already stores — `~/.claude/.credentials.json` on Windows and Linux, the login keychain on macOS, read through `/usr/bin/security find-generic-password`. The token is never logged, cached, written back, or refreshed, and no keychain verb that would change what is stored appears in the shipped bundle.
- Codex usage comes from the local Codex CLI over its own JSON-RPC interface. Codex keeps custody of its credentials; this extension never reads them.
- No prompt, source code, or file content is transmitted anywhere. Agent transcripts are watched for the fact that they changed and never opened, and the extension writes no files of its own.
- The last usage reading is kept in the extension's own VS Code state so the other windows can show it instead of asking again. It holds percentages, reset times, window lengths, and the plan name; no token, no transcript.
