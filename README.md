# Agent Usage Bar

Shows how much of your Claude Code and Codex plan is left, in the VS Code status bar.

Both numbers come from the account rather than from anything counted locally, so usage you spent on
another machine, in a terminal, or in another editor still shows up here.

## What it shows

One status bar item per provider, each with its own mark:

| Example                            | Meaning                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `5h 42% (2h 15m)`                  | 42% of the 5-hour window used, which refills in 2h 15m.         |
| `5h 42% (2h 15m) · 7d 18% (4d 6h)` | Both windows, in `full` display mode.                           |
| `5h 58% left (2h 15m)`             | The same reading with `percentageMode` set to `remaining`.      |
| `~5h 0%`                           | The window reset since this reading; `0%` is assumed, not read. |
| `5h 42% (2h 15m)` + history icon   | The reading is more than ten minutes old.                       |
| `--`                               | No reading yet. The tooltip says why.                           |

The item turns yellow past the warning threshold and red past the error threshold, both measured on
the percentage **used** whichever way you display it. It also turns red, with a reason, whenever a
provider reports the account as stopped — a spend limit or a hard rate limit — however low the
percentage happens to be.

Hover for a tooltip with a themed bar per window — filled to the percentage and colored by the same
thresholds as the item — the plan name, exact reset times, any credit balance, the reason the last
refresh failed if one did, and links to refresh or to open the settings. Click either item for a
menu that toggles a provider, refreshes, or opens the settings.

## One reading for every window

Every VS Code window runs its own copy of an extension, so six open windows normally means six of
everything: six timers, six requests, and six items that disagree with each other for a few seconds
after each one lands.

This extension does not work that way. The windows of a profile share one reading and one schedule:

- **Six windows cost about what one does.** Only one window actually asks; the rest read the answer.
- **All of them show the same number**, including the ones that never made a request.
- **No window has a timer of its own.** The refresh interval belongs to the machine, so closing the
  window that happened to be reading costs one cycle rather than leaving the others stalled.
- **A rate limit is honoured everywhere at once**, and every item counts the same wait down.

There is no leader and nothing is elected, so there is nothing to get stuck. See
[Sharing between windows](#sharing-between-windows) for how it works.

## Requirements

- VS Code 1.100.0 or newer, desktop.
- For the Claude item: [Claude Code](https://claude.com/claude-code) installed and signed in.
- For the Codex item: [Codex](https://chatgpt.com/download/) installed and signed in, either through
  the desktop app or as the standalone [CLI](https://github.com/openai/codex). The extension finds
  whichever you have, including the copy the Codex IDE extension ships.

Neither is required for the other. A provider that is not installed or not signed in says so in its
tooltip; switch it off in the settings and its item disappears.

## Install

From the Marketplace, or from a `.vsix`:

1. Download or build a `.vsix` (see [CONTRIBUTING.md](CONTRIBUTING.md)).
2. Run **Extensions: Install from VSIX...** in VS Code and pick the file.

## Settings

Run **Agent Usage Bar: Open settings**, or click either status bar item and pick **Open settings**.

| Setting                                | Default   | Purpose                                           |
| -------------------------------------- | --------- | ------------------------------------------------- |
| `agentUsageBar.displayMode`            | `compact` | Show one or both standard usage windows.          |
| `agentUsageBar.percentageMode`         | `used`    | Show used or remaining percentage.                |
| `agentUsageBar.warningThreshold`       | `80`      | Warning color threshold based on used percentage. |
| `agentUsageBar.errorThreshold`         | `95`      | Error color threshold; never falls below warning. |
| `agentUsageBar.claude.enabled`         | `true`    | Show Claude Code usage.                           |
| `agentUsageBar.codex.enabled`          | `true`    | Show Codex usage.                                 |
| `agentUsageBar.claude.label`           | `""`      | Text to show instead of the Claude mark.          |
| `agentUsageBar.codex.label`            | `""`      | Text to show instead of the Codex mark.           |
| `agentUsageBar.refreshIntervalSeconds` | `300`     | Background refresh interval, clamped to 30–3600.  |

In `compact` mode the item shows the shortest window, unless a longer one is the reason the item is
colored — a highlighted status bar always explains itself.

Each provider is drawn with its own monochrome mark. Set a label if you would rather see your own
text; it accepts a plain string or a codicon reference such as `$(sparkle)`, and is collapsed to a
single line and cut to 24 characters so a hand-edited value cannot stretch the status bar.

## Troubleshooting

Every failure keeps the last good numbers on screen rather than blanking the item, so the tooltip is
where the reason lives.

| The tooltip says                                   | What it means                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| No Claude Code sign-in was found                   | Run Claude Code once so it stores a sign-in. On macOS, allow the keychain prompt. |
| The Claude Code sign-in has expired                | Run Claude Code; it renews its own token. This extension deliberately will not.   |
| Claude Code is no longer signed in                 | The service rejected the stored token. Sign in to Claude Code again.              |
| The Claude usage service is rate limiting requests | Nothing to do. The tooltip names the moment the read resumes, and it resumes.     |
| The Claude usage service could not be reached      | Network or proxy. The last reading stays on screen with its age.                  |
| Codex reported no rate-limit windows               | Sign in to Codex, or the account has no windows to report.                        |
| The Codex CLI could not be started                 | Codex is not installed where this looks; see [Platform scope](#platform-scope).   |
| The Codex app server did not answer in time        | The CLI stopped responding. The next read starts a fresh one automatically.       |

**A macOS keychain prompt was declined.** That is respected rather than retried: the read is not
attempted again for half an hour, so declining does not turn into a prompt every five minutes. Run
**Agent Usage Bar: Refresh usage** to ask again immediately.

**The numbers look old.** A history icon and a note in the tooltip appear once a reading is more
than ten minutes old, so a stale number never passes as current. Refresh from the menu to force a
read that ignores the usual floor.

**Nothing appears at all in a Remote-SSH, WSL, or dev container window.** The extension runs on the
machine your editor runs on, which is where both agents keep their sign-ins. See
[Platform scope](#platform-scope).

## Data access

This extension reads a credential, so the boundary is worth stating exactly. Usage is a property of
the account rather than of this machine, so both providers are asked about the account instead of a
local scoreboard being counted up.

### Codex

The extension starts `codex app-server` and asks it over JSON-RPC on stdin and stdout. Codex holds
its own credentials and refreshes them itself, so this extension never reads or handles a Codex
token: `~/.codex/auth.json` stays outside the boundary, and `npm run audit:bundle` fails the build if
that path appears in the shipped bundle. When the CLI cannot be located or is signed out, the item
reports that rather than guessing from local files.

### Claude Code

**The extension reads the token Claude Code stores, spends it on one request, and drops it.** That
request goes to `https://api.anthropic.com/api/oauth/usage`, the same endpoint the official Claude
Code extension uses for this.

The token is never logged, cached, or written back — not to the shared state, not to settings, not
to the extension's secret storage. Keeping a copy would trade one file read every five minutes for
a second place a credential lives: one that goes stale when Claude Code rotates the token, and that
would have to be invalidated on sign-out.

It is also never refreshed, deliberately. A refresh rotates the stored token, so racing Claude Code
for it would sign Claude Code itself out. When the token is expired or rejected, the extension says
so and leaves the renewing to Claude Code.

**Where the token lives** depends on the platform:

| Platform       | Location                                                      |
| -------------- | ------------------------------------------------------------- |
| Windows, Linux | `~/.claude/.credentials.json`                                 |
| macOS          | The login keychain, under the item Claude Code created for it |

#### Reading the macOS keychain

The keychain is read through the tool macOS ships for it: `/usr/bin/security find-generic-password`,
started directly at that absolute path with its arguments as a list, so nothing on `PATH` can stand
in for it and no argument can be read as a command. It only reads. No keychain verb in this
extension changes what is stored, and `npm run audit:bundle` fails the build if one ever appears.

The file is tried first even on macOS, because it is the cheaper question and Claude Code falls back
to it where the keychain is not available. An ordinary macOS read therefore starts one short-lived
process, and an ordinary read anywhere else starts none.

If macOS puts a prompt in front of that read, the answer is respected rather than worked around:

| Outcome                       | What happens next                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| No such item                  | Asked again on the next interval; asking costs nothing.                                       |
| Declined, locked, or not ours | Not asked again for half an hour, so a declined prompt does not come back five minutes later. |
| No answer within five seconds | Abandoned, and counted as a refusal.                                                          |

`security` exits with the status it was given, so these are told apart by its exit code rather than
guessed at. Only one window ever asks, because only one window does the reading.

### Agent transcripts

`~/.codex/sessions` and `~/.claude/projects` are watched purely as an "an agent just ran" signal:
only the fact that a `.jsonl` file changed is used, and once the writes settle a refresh is
requested. The transcripts themselves are never opened.

Codex also pushes an `account/rateLimits/updated` notification, but that only arrives while its app
server is running, and this extension stops that process ten minutes after the window last read
rather than keeping a child process resident for a signal. The watch covers the rest of the time,
and is what starts a fresh app server when an answer is wanted again.

Every automatic read sits behind a floor of thirty seconds per provider, whichever trigger asked for
it: a single long turn writes its transcript in bursts, and the percentages it moves are not worth a
request each. A refresh you ask for from the menu ignores the floor.

### Sharing between windows

Each reading is stored in the extension's own state, which VS Code shares between the windows of a
profile, together with the moment the read was started. A window that finds a reading younger than
the floor displays it rather than asking again, and a rate-limit wait is honoured by all of them at
once.

The background interval is the machine's rather than each window's: whichever window notices it has
run out does the reading, so a window closed mid-read costs one cycle rather than a stalled status
bar. There is no leader and nothing to elect — the window that read last simply keeps a few seconds
of head start, which is enough for the reading to settle on one of them. Two windows arriving in the
same instant both write their claim and then re-read it before spending a request, so all but one
stand down. That is not a lock and cannot be one; on a rare tie the cost is a second request, not a
wrong number.

### What is stored, and what never leaves

That one endpoint is the only network target in the extension. `npm run audit:bundle` pins the full
allowlist, so a second URL, a shell execution, or any filesystem write fails the build. The
extension opens files only to parse them and writes no files of its own.

It persists exactly two things, both through VS Code's own APIs:

- Your settings, when you toggle a provider from the menu.
- The last usage reading, so the other windows can show it — percentages, reset times, and the plan
  name.

Neither carries a token, a prompt, or any file content. There is no telemetry, no runtime
dependency, no custom credential path, and no custom update mechanism. No prompt, code, or file
content ever leaves the machine.

### Resets, staleness, and rate limits

A reading is a point-in-time snapshot, so a percentage can predate a window reset. The extension
detects that from the recorded reset time, shows `0%` behind a `~` marker, and suppresses the
warning color rather than presenting an unconfirmed number as current. A reading older than ten
minutes is marked with its age in the tooltip, and a failed refresh keeps the last good numbers
rather than blanking the item.

When the Claude usage service rate limits a request, the `Retry-After` it sends is honoured for
every trigger alike — the background poll, local agent activity, and the menu — and the tooltip
counts that wait down instead of asking again. A refusal that names no window is held for a minute,
and one naming more than an hour is asked again at the hour: a wait longer than the longest refresh
interval is indistinguishable from a stall, and one long enough to overflow a timer is worse than
that.

## Platform scope

Version 0.1.0 is developed and hand-tested on desktop VS Code on Windows. Both other desktop
platforms are implemented rather than assumed: the Codex install layouts and the macOS keychain read
are covered by tests that run on all three CI runners, and the file watcher is exercised against the
real `recursive` implementation on each. What no runner can supply is an actual Codex install or an
actual Claude Code sign-in, so what remains unconfirmed on macOS and Linux is whether those live in
the places this looks — not whether looking there works.

The extension runs on the machine your editor is running on, which is where both agents keep their
sign-ins. In a Remote-SSH, WSL, or dev container window it therefore reports the usage of the local
account. If your agents run on the remote side, their usage is not what you will see.

There is no web build. It reads local files and starts a local process, neither of which exists in a
browser.

## Contributing

Setup, the architecture, the scripts, and how the provider marks are built are all in
[CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md).

## License and trademarks

MIT; see [LICENSE](LICENSE). No third-party file is bundled: the icon font in
`assets/agent-usage-bar.woff` was drawn and generated for this project, so no upstream font license
applies.

The two glyphs in that font depict the Claude and OpenAI marks. Claude and Anthropic are trademarks
of Anthropic; Codex and OpenAI are trademarks of OpenAI. Redrawing a mark does not make it ours.
They appear here for one purpose — identifying which usage figure belongs to which tool — and this
project is not affiliated with, endorsed by, or sponsored by either company. Either mark can be
replaced with your own text through the `agentUsageBar.claude.label` and `agentUsageBar.codex.label`
settings.
