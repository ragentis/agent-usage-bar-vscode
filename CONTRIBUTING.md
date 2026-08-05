# Contributing

Everything a change to this extension needs: how to run it, how it is put together, and what has to pass before it ships.

## Setup

Install the toolchain once:

```powershell
npm ci --ignore-scripts
```

**Debugging.** Press `F5`. VS Code bundles the extension with source maps and opens a second window (the Extension Development Host) with it loaded, where breakpoints in `src/**` work. Run the `npm: bundle:watch` task while iterating, and `Ctrl+R` in that window is all a change needs.

**Daily use.** Build a package and install it like any other extension:

```powershell
npm run package:local
```

Then run **Extensions: Install from VSIX...** in VS Code and pick the generated `.vsix`.

**Checks.**

```powershell
npm run verify
```

That runs the type check, lint, format check, tests, and a local package build, and it is exactly what CI runs on every push and pull request. Linting is `oxlint` with type-aware rules through `oxlint-tsgolint`, and formatting is `oxfmt`; both are configured in `.oxlintrc.json` and `.oxfmtrc.json`, and the type-aware rules are why the toolchain is on TypeScript 7.

## Architecture

The layout follows one rule: **the parts worth testing import nothing that needs an extension host.** `usage-bar.ts` takes its providers as ports rather than building them, so everything above the wiring in `extension.ts` is plain TypeScript that runs under `vitest`.

| File | Reaches for | Holds |
| --- | --- | --- |
| `extension.ts` | vscode | Activation and wiring. The only place providers are built. |
| `settings.ts` | vscode | Reading and writing the settings section. |
| `status-bar.ts` | vscode | Drawing a `StatusBarItem`, and wrapping the tooltip. |
| `menu.ts` | vscode | The click menu. |
| `claude-api.ts` | `fetch` | The account endpoint, and parsing its response. |
| `claude-credentials.ts` | node | Token sources: the file, and the macOS keychain. |
| `codex-appserver.ts` | node | CLI discovery, the JSON-RPC lifecycle, and parsing its replies. |
| `watcher.ts` | node | `fs.watch`, with a debounce and a backoff. |
| `claude.ts`, `codex.ts` | node | Per-provider paths. |
| `usage-bar.ts` | — | When a provider is read, held, adopted, and painted. |
| `read-coordinator.ts` | — | Which window reads, and when. |
| `shared-state.ts` | — | The shared entry, serialized and re-validated on the way back. |
| `usage.ts` | — | Shared types, and the validators every parser goes through. |
| `configuration.ts` | — | Settings as plain values, plus the rules over them. |
| `formatting.ts` | — | Status text, percentages, and durations. |
| `tooltip.ts` | — | Tooltip lines, and the markdown escaping they need. |

Four types exist only to keep that line drawable: `CodexProcess`, `LaunchCodex`, `SharedStore`, and `SettingReader` each name the slice of a host or machine facility their module actually uses, so a test can stand one up instead of the real thing.

## Tests

Tests cover the account response parsers for both providers, the file watcher, the formatting helpers, the shared state and the arrangement that decides which window reads, and `usage-bar.ts`, where a rate-limit wait, a lease, a provider toggle, and a window closing all reach for the same state.

The Codex app server takes its launch through `LaunchCodex` for the same reason, which is what lets the half a reply never reaches be tested — a frame split across two chunks, a server that goes silent, a stop landing inside a start — none of which a real Codex install can be made to do on demand. The rest is covered by `tsc --strict`.

One `tsconfig.json` covers `src/` and `test/` alike, so the editor checks exactly what `npm run typecheck` checks.

## Scripts

| Script | Purpose |
| --- | --- |
| `clean` | Removes `dist/` and any built `.vsix`. |
| `bundle` | Production esbuild build into `dist/extension.js`, plus `dist/meta.json`. |
| `bundle:dev` | Same build with source maps; this is the `F5` pre-launch task. |
| `bundle:watch` | Dev build that keeps rebuilding, so `Ctrl+R` alone picks a change up. |
| `typecheck` | `tsc --noEmit`. esbuild only strips types, so this is the only type check. |
| `lint` / `format` | `oxlint` and `oxfmt`; `format:check` reports instead of writing. |
| `test` / `test:watch` | `vitest`, which runs the TypeScript tests without a build step. |
| `audit:bundle` | Checks the built bundle against the promises under **Data access**. |
| `verify` | The whole gate: type check, lint, format check, tests, package. |
| `vscode:prepublish` | Bundle and audit. `vsce` runs this itself; never call it by hand. |
| `package:local` | Cleans, then packages a `.vsix` through `vsce`. |

The build writes two untracked files: `dist/extension.js` is what ships, and `dist/meta.json` lists every input that reached the bundle so `audit:bundle` can check it.

## The bundle audit

`npm run audit:bundle` is the enforcement behind the [Data access](README.md#data-access) section of the README: the claims a reader cannot check by looking at the status bar, and the ones that decay silently as code changes. It reads `package.json`, `dist/meta.json`, and the built bundle, and fails on any of:

| Check | Fails on |
| --- | --- |
| Runtime dependencies | Any entry under `dependencies`. |
| Bundle inputs | An input that did not come from `src/`. |
| Network targets | Any URL other than the one allowed endpoint. |
| Shell execution | `execSync`, `execFileSync`, or `shell: true`. |
| Filesystem writes | `writeFile`, `appendFile`, or `createWriteStream`. |
| Codex credentials | The literal `.codex/auth.json` path. |
| Keychain writes | `add-`, `delete-`, or `set-generic-password`, and `unlock-keychain`. |
| Absolute paths | A rooted path outside the pinned list of two programs the extension starts. |

A change that needs one of these is a change to the promise the README makes. Update both, or find another way.

## Provider marks

VS Code renders status bar text through the codicon pipeline, which accepts an icon font and nothing else, so the two marks ship as `assets/agent-usage-bar.woff`, registered through `contributes.icons`. The font is generated with [Fontello](https://fontello.com) from `assets/fontello-config.json`; open that file in Fontello to edit the marks or rebuild it. Keep the pinned code points on re-import — `U+E800` for Codex and `U+E801` for Claude — because `contributes.icons` addresses the glyphs by exactly those characters.

## Releasing

[.vscodeignore](.vscodeignore) denies everything and then allows exactly what ships, so a new asset or document is invisible to the package until it is listed there. `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version follows [semantic versioning](https://semver.org/spec/v2.0.0.html).
