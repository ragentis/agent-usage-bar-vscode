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

That runs the type check, lint, format check, and tests — the same checks CI runs on every push and pull request. CI adds two of its own: packaging, which is where `audit:bundle` runs and which `npm run package:local` is locally, and a refusal of any commit subject not written to [the convention](.github/commit-instructions.md). Linting is `oxlint` with type-aware rules through `oxlint-tsgolint`, and formatting is `oxfmt`; both are configured in `.oxlintrc.json` and `.oxfmtrc.json`, and the type-aware rules are why the toolchain is on TypeScript 7.

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
| `verify` | The local gate: type check, lint, format check, tests. |
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

## Failure messages

Every message a read can fail with is written to one shape, because the tooltip lays a failure out by reading that shape back: the first sentence is what happened, and anything after it is what the reader can do about it, drawn on a line of its own under a lightbulb. A message with nothing to do about it is one sentence, and one line. Punctuate them as prose — the full stop is where the tooltip breaks a message that will not fit, and a semicolon leaves it nowhere to land.

Both parts are written to fit the line they are drawn on: `LINE_COLUMNS` less `LABEL_COLUMNS` for the statement, and less `HINT_COLUMNS` for the remedy, all in `tooltip.ts` — 39 and 58 characters as those numbers stand. Longer is not broken, since the line wraps, but the block then runs to three lines where every other failure takes two. Where the statement already names something, the remedy leans on it rather than saying it again: _No Claude Code sign-in was found. Sign in to the CLI or extension._

A message also crosses to the other windows through the shared entry, which reads it back with `validMessage` rather than `validLabel` — a label is a word or two beside a number and is refused when it is longer. Words a provider chose rather than this extension are marked `verbatim`: those are drawn as they came, never read for a remedy, and cut to two lines rather than swapped for a sentence of ours.

## Provider marks

VS Code renders status bar text through the codicon pipeline, which accepts an icon font and nothing else, so the two marks ship as `assets/agent-usage-bar.woff`, registered through `contributes.icons`. The font is generated with [Fontello](https://fontello.com) from `assets/fontello-config.json`; open that file in Fontello to edit the marks or rebuild it. Keep the pinned code points on re-import — `U+E800` for Codex and `U+E801` for Claude — because `contributes.icons` addresses the glyphs by exactly those characters.

## Releasing

Nothing about a release is typed by hand. Release Please reads the commit subjects that landed on `main` — the types and what each one costs are in [commit-instructions.md](.github/commit-instructions.md) — and keeps a pull request titled `chore: release X.Y.Z` in step with them, so ten pushes still produce one pull request and one version. **Two decisions stand between a commit and the stores: merging that pull request, and approving the deployment in the last phase.** Squash-merge it, so exactly one release commit lands.

[release.yml](.github/workflows/release.yml) then runs in four phases, named as its jobs:

| Phase | What it does |
| --- | --- |
| **Prepare the release** | Refreshes that pull request, or on its merge tags the commit and drafts the release |
| **Verify the release** | Runs the whole of [ci.yml](.github/workflows/ci.yml) again at the release commit |
| **Publish the release** | Attaches the verified VSIX and takes the release out of draft |
| **Publish to …** | Waits for approval, then Visual Studio Marketplace and Open VSX, independently |

The tag lands in the first phase rather than the last, through `force-tag-creation`: a draft release GitHub holds no tag for is one the next run cannot find, and it would replay the whole history into the following changelog. So the tag is public at once, while the release page and its package are not. Verification has little left to find by then — the release commit carries byte-identical sources to what was already on `main`, since Release Please touches only `package.json`, `package-lock.json`, `CHANGELOG.md`, and `.release-please-manifest.json`.

The last phase waits behind the `release` environment, which owns both store tokens and names a required reviewer. That is where a pause belongs: a GitHub release can still be edited or deleted, but a Marketplace version is immutable the moment it lands. The package is attached before the request arrives, so it can be downloaded and installed before anyone approves.

**When something fails.** A flaky test or an expired store token is a **Re-run failed jobs** on the same run, which GitHub allows for thirty days; after that the package is still on the release to publish by hand. Both registries skip a version they already have, so a repeat costs nothing. A genuine break is the one case that differs — that version is spent, since the manifest has moved on — so push the fix, let the next release pull request open, and delete the draft with `gh release delete vX.Y.Z --yes`. Leave its tag: it is the boundary the next run reads, and removing it is what `force-tag-creation` is there to prevent.

**Things worth knowing before they surprise you.**

- [.vscodeignore](.vscodeignore) denies everything and then allows exactly what ships, so a new asset or document is invisible to the package until it is listed there.
- `README.md` is packaged, which makes it the store page: prose fixed there reaches the Marketplace only in a published version. `assets/screenshot.png` is not packaged — `vsce` rewrites the relative link to `github.com/…/raw/HEAD/…` — so the image is served live from `main` and changes without a release.
- The `autorelease:` labels are the state machine. An open release pull request carries `autorelease: pending`, and that label is how the merge is recognized. Remove it and the release is never created.
- **Prevent self-review** on the `release` environment has to stay off; with one maintainer, turning it on leaves an approval nobody may give.
- A run waiting for that approval still holds the `release` concurrency group, so pushes to `main` stop refreshing the release pull request until it is answered.
- Hand edits to `CHANGELOG.md` inside the release pull request do not survive: the branch is rewritten whenever a later commit changes the release notes. Changelog wording is fixed by fixing the commit subject before it lands.
- A `Release-As: X.Y.Z` footer on any commit forces that version outright, and is the only way to reach 1.0, since below it even a breaking change stops at a minor bump. Nothing needs unsetting afterwards, as `bump-minor-pre-major` applies only below 1.0. Do not use `release-as` in [release-please-config.json](release-please-config.json) instead; there it pins the version until someone removes it.
- CI does not start on the release pull request by itself. It is opened by the default `GITHUB_TOKEN`, and a run from that token parks until someone with write access clicks **Approve workflows to run** — the same button a first-time contributor's pull request shows. Ignoring it is fine here, since phase 2 verifies that commit anyway. Requiring status checks on `main` would make the click compulsory before a release could merge; any credential other than `GITHUB_TOKEN` lifts it, a GitHub App token being preferable to a personal one, as it is scoped here and does not expire.
