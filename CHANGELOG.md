# Changelog

Notable changes to Agent Usage Bar. Release Please builds this file from the [commit subjects](.github/commit-instructions.md) that land on `main`, and the versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0](https://github.com/ragentis/agent-usage-bar-vscode/compare/v0.1.0...v0.2.0) (2026-08-07)


### Added

* **tooltip:** state a failure as what happened and what to do ([ae6a5ef](https://github.com/ragentis/agent-usage-bar-vscode/commit/ae6a5efed97896b0fde43a4a612c768563384c9c))


### Fixed

* **claude:** send a missing sign-in to the CLI or the extension ([b9fefdc](https://github.com/ragentis/agent-usage-bar-vscode/commit/b9fefdc71f29d2601a3b8a6f3e0bb861e3c9b11c))

## 0.1.0 (2026-08-06)

First release. Desktop VS Code on Windows, macOS, and Linux; developed and hand-tested on Windows, with the per-platform paths covered by tests on all three CI runners.

### Added

* Separate Claude Code and Codex status bar items, each drawn with its own mark.
* Compact and full display modes, and used or remaining percentages.
* Configurable warning and error color thresholds, based on the percentage already used.
* A click menu for toggling either provider, refreshing, and opening settings.
* Account-level readings, so usage spent on another machine or in another client still shows up.
* A refresh when a local agent writes, floored at one read per thirty seconds, plus a configurable background interval.
* One reading shared by every open window, so the cost of six windows is the cost of one and all of them show the same number.
* A history icon and a tooltip note once a reading is more than ten minutes old.
* A tooltip drawn with theme colors: a filled bar per window, dimmed detail lines, and refresh and settings links.
* A pace beside each window's reset time, off with `agentUsageBar.showPace`: the 5-hour window forecast to when it runs out or where it lands by the reset, the weekly one only clocked, since its hours run through nights and days off and a forecast across them would mislead.
* A `~` marker when a window has reset since the last reading, so a refilled quota never reads as full.
* An error color and a reason whenever a provider reports the account as stopped, however low the percentage is.
