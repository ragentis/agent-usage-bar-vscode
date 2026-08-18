# Changelog

Notable changes to Agent Usage Bar. Release Please builds this file from the [commit subjects](.github/commit-instructions.md) that land on `main`, and the versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0](https://github.com/ragentis/agent-usage-bar-vscode/compare/v0.3.1...v0.4.0) (2026-08-18)


### Added

* **claude:** show per-model weekly limits as their own windows ([34aaadf](https://github.com/ragentis/agent-usage-bar-vscode/commit/34aaadf35814a86c2d5a779bbccc17a67a491d70))
* **tooltip:** draw the provider mark larger in the title ([62f6635](https://github.com/ragentis/agent-usage-bar-vscode/commit/62f66351c6151c5d5a0d5a172cf6856ca94f9546))
* **tooltip:** draw the weekly mark as a haloed glyph ([2b42447](https://github.com/ragentis/agent-usage-bar-vscode/commit/2b42447684b3ea434c2ea1ba4aa8a8912f0a4783))
* **tooltip:** mark elapsed time on the weekly bar ([660830d](https://github.com/ragentis/agent-usage-bar-vscode/commit/660830d6faef37b41e78c998246a6b53c446741e))
* **tooltip:** show daily activity from agent transcripts ([7e07fbb](https://github.com/ragentis/agent-usage-bar-vscode/commit/7e07fbb463731efff38832616629e2e81d5f12a6))


### Fixed

* **codex:** recover from stale app-server credentials ([381e22d](https://github.com/ragentis/agent-usage-bar-vscode/commit/381e22dcdc6983dc19165e5876b51cf613569065))
* **codex:** replace a signed-out app server without watching auth.json ([00909e4](https://github.com/ragentis/agent-usage-bar-vscode/commit/00909e4de6a378adcf4125421f6d4ef6008087f3))
* **refresh:** back off repeated rate limits and read no more than once a minute ([bad1b31](https://github.com/ragentis/agent-usage-bar-vscode/commit/bad1b3121eebe90bbbe73fd5eeecc194acda3756))
* **tooltip:** give the footer more room under its rule ([421211f](https://github.com/ragentis/agent-usage-bar-vscode/commit/421211f5ad0dafd22b64f2cb079ced28c021875b))

## [0.3.1](https://github.com/ragentis/agent-usage-bar-vscode/compare/v0.3.0...v0.3.1) (2026-08-13)


### Fixed

* **status-bar:** adjust tooltip icon alignment for better visibility ([d2ea6f1](https://github.com/ragentis/agent-usage-bar-vscode/commit/d2ea6f1a3c6c82f4d7c2c16e64c81f6c22aab1d7))

## [0.3.0](https://github.com/ragentis/agent-usage-bar-vscode/compare/v0.2.0...v0.3.0) (2026-08-12)


### Added

* **codex:** show when the soonest reset credit expires ([df02e6b](https://github.com/ragentis/agent-usage-bar-vscode/commit/df02e6b8e6c5f07d12afc6b38f84584cc6a911a4))
* **status-bar:** add pace-aware warning mode ([4b1fa7d](https://github.com/ragentis/agent-usage-bar-vscode/commit/4b1fa7de4641a27c2de1d79d3c3c83b96b4f5bc8))

## [0.2.0](https://github.com/ragentis/agent-usage-bar-vscode/compare/v0.1.0...v0.2.0) (2026-08-09)


### Added

* **tooltip:** state a failure as what happened and what to do ([ae6a5ef](https://github.com/ragentis/agent-usage-bar-vscode/commit/ae6a5efed97896b0fde43a4a612c768563384c9c))


### Fixed

* **claude:** send a missing sign-in to the CLI or the extension ([b9fefdc](https://github.com/ragentis/agent-usage-bar-vscode/commit/b9fefdc71f29d2601a3b8a6f3e0bb861e3c9b11c))
* **status-bar:** align provider marks in tooltips ([2446d19](https://github.com/ragentis/agent-usage-bar-vscode/commit/2446d198efb60adc84780cad57affecb92256a51))

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
