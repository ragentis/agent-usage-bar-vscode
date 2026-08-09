# Commit message instructions

Use Conventional Commits for every commit.

```text
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

## Types

The type decides the next version and the changelog section. Use no type outside this table.

| Type       | Use for                                   | Version | Changelog section |
| ---------- | ----------------------------------------- | ------- | ----------------- |
| `feat`     | New user-visible behavior or settings     | minor   | Added             |
| `fix`      | Bug fixes, including security fixes       | patch   | Fixed             |
| `perf`     | Performance improvements                  | patch   | Performance       |
| `revert`   | Undoing a change that already shipped     | patch   | Reverted          |
| `refactor` | Internal changes without behavior changes | —       | —                 |
| `test`     | Test additions or corrections             | —       | —                 |
| `docs`     | Documentation-only changes                | —       | —                 |
| `style`    | Formatting-only changes                   | —       | —                 |
| `build`    | Bundling, packaging, or build tooling     | —       | —                 |
| `ci`       | GitHub Actions and other CI changes       | —       | —                 |
| `chore`    | Repository maintenance not covered above  | —       | —                 |

## Scopes

The scope is optional. Prefer one of these when it makes the affected area clearer:

- `claude` — Claude credentials, API usage, and polling
- `codex` — Codex app-server integration and usage data
- `status-bar` — status items, tooltips, menus, and display lifecycle
- `config` — extension settings and configuration handling
- `watcher` — local activity detection and refresh triggers
- `formatting` — usage values, time windows, and display formatting
- `build` — bundling, packaging, and cleanup scripts
- `audit` — the bundle security checks
- `deps` — dependency updates
- `ci` — workflows and automated verification
- `docs` — user or contributor documentation, when the scope adds useful context
- `repo` — repository-wide maintenance

Use a more specific module or feature name when it is clearer than this list. Do not force a scope onto a repository-wide or obvious documentation change.

## Rules

- Write the description in imperative mood, lowercase after the colon, without a trailing period.
- Keep the first line concise, preferably at or below 72 characters.
- Describe one coherent change per commit; use the body to explain motivation or non-obvious tradeoffs.
- Put issue references and other metadata in footers.
- Visual or user-facing display changes are `feat` or `fix`, never `style`.
- Mark a breaking change with `!` after the type or scope and add a `BREAKING CHANGE:` footer explaining the migration impact. Treat renamed or removed settings, commands, and other extension contracts as breaking changes.

## Examples

```text
feat(status-bar): show Codex credits in the tooltip
fix(claude): ignore stale responses after disabling the provider
refactor(config): separate redraw and refresh handling
test(watcher): cover rapid log file updates
build(audit): pin the endpoints the bundle may reach
ci: run verification on Windows
docs: document provider privacy behavior
feat(config)!: rename the percentage mode setting

BREAKING CHANGE: Replace agentUsageBar.percentage with
agentUsageBar.percentageMode in user settings.
```
