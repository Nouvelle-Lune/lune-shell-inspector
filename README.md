# Lune Shell Inspector

**Background shell jobs for [Pi](https://pi.dev), with a live dock, an interactive `/shell` inspector, and agent-aware completion notifications.**

Long-running commands should not block the agent, and background commands should not disappear into an invisible process. Lune Shell Inspector gives Pi a managed background execution path while keeping ordinary foreground `bash` behavior native.

> Run the work in the background. Keep the state visible. Bring the result back to the agent.

## Why

Pi's built-in `bash` tool is excellent for commands whose result is needed immediately. Long-running work is different: test suites, builds, dev servers, training jobs, data processing, and other independent commands can safely continue while the agent does something else.

Lune Shell Inspector adds that second path without replacing the first one visually or semantically.

- **Foreground stays native.** Calls without `mode`, or with `mode: "foreground"`, delegate to Pi's built-in bash tool and keep its standard transcript rendering.
- **Background returns immediately.** `mode: "background"` starts a managed shell job and lets the agent continue.
- **The job stays visible.** A compact dock below the editor shows running and settled shells.
- **`/shell` opens a real inspector.** Browse jobs, inspect status and metadata, and follow or scroll terminal output.
- **The agent can inspect jobs too.** The `background_shell` tool exposes current status and opt-in intermediate output.
- **Completion comes back automatically.** When a background shell settles, its final status and output are delivered back to the agent so it can continue without polling forever.

## Quick start

Install the package from GitHub:

```bash
pi install git:github.com/Nouvelle-Lune/lune-shell-inspector
```

Then start Pi normally:

```bash
pi
```

You do not need a separate command to enter a special shell mode. The extension augments Pi's existing `bash` tool with an optional execution mode.

For example, you can ask Pi:

```text
Run the test suite in the background and keep working on the failing module.
```

or:

```text
Start the dev server in the background, then inspect its output once it is ready.
```

At tool level, the added choice is simply:

```ts
bash({
  command: "npm test",
  mode: "background",
})
```

Foreground remains the default.

## Live shell dock

As soon as Pi starts a background shell, Lune Shell Inspector mounts a small status surface below the editor.

A single running shell is intentionally compact:

```text
1 running shell · npm test · 12s · /shell to open
```

A settled shell collapses to the result:

```text
1 shell completed in 18s · /shell to open
```

With several jobs, the dock becomes a status summary:

```text
5 shells · 3 running · 1 completed · 1 failed · /shell to open
```

The dock refreshes while jobs are running and disappears when there are no shell jobs to show.

## Interactive `/shell` inspector

Run `/shell` to open the centered shell inspector overlay.

The left pane is the job list. The right pane shows the selected command, status, working directory, duration, exit code when available, and its terminal output.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Shell inspector                                      3 shells · 1 running │
├──────────────────────────┬───────────────────────────────────────────┤
│ › ● npm test     running │ ● npm test                                │
│   ● npm build  completed │ running · /workspace · 12.4s              │
│   ● lint        completed │                                           │
│                          │ Output · 84 lines                          │
│                          │ PASS test/unit/shell-manager.test.ts       │
│                          │ PASS test/unit/shell-inspector.test.ts     │
│                          │ ...                                       │
├──────────────────────────┴───────────────────────────────────────────┤
│ ↑↓/jk shell · ⇧↑↓/jk scroll · Home/End · Esc close                  │
└──────────────────────────────────────────────────────────────────────┘
```

Keyboard controls:

| Action | Keys |
| --- | --- |
| Select shell | `↑` / `↓` or `k` / `j` |
| Scroll output | `Shift+↑` / `Shift+↓` or `Shift+k` / `Shift+j` |
| Jump to oldest output | `Home` |
| Follow newest output | `End` |
| Close inspector | `Esc` |

Output follows the tail by default. Scroll upward and the inspector enters a paused view instead of letting newly streamed lines drag the viewport away from what you are reading. The header shows how many newer lines are hidden until you return to the tail.

## Terminal-aware output

Background stdout/stderr is not treated as plain text.

Each job feeds a headless xterm screen, so carriage-return redraws, ANSI styling, erase-line sequences, progress bars, spinners, and other VT behavior are interpreted before the dock, `/shell`, or the agent reads the screen.

That matters for long-running commands. A progress bar that rewrites one line should look like one changing line, not hundreds of raw `\r` fragments and escape sequences.

The execution itself still uses Pi's local bash backend and a pipe rather than a PTY. The headless terminal is the observation layer.

## Agent integration

Background mode is designed for the agent loop, not only for the human watching the TUI.

### `bash`

Lune Shell Inspector registers a wrapper under Pi's existing `bash` tool name.

- `mode: "foreground"` — wait for the command and delegate to Pi's built-in bash implementation.
- `mode: "background"` — start a managed job and return immediately.

The extension also adds tool guidance that encourages foreground execution when later work depends on the result, and background execution when a long-running command can safely proceed independently.

### `background_shell`

The companion `background_shell` tool lets the agent inspect jobs before they finish.

It can:

- list every managed background shell;
- query specific shell IDs;
- return status without pulling output into context;
- optionally include the selected shell's current terminal screen.

Output is opt-in per job so a routine status check does not unnecessarily spend model context on large logs.

### Completion notification

When a background job becomes `completed`, `failed`, or `killed`, the extension sends its final command, status, exit code/error when present, and retained output back into the agent loop as a steer message.

This closes the async loop: Pi can start independent work, continue elsewhere, and react when the shell is actually done.

## Execution model

```text
                         ┌───────────────────────────┐
bash(mode=foreground) ──▶│ Pi built-in bash         │──▶ native transcript
                         └───────────────────────────┘

                         ┌───────────────────────────┐
bash(mode=background) ──▶│ managed background shell │
                         └─────────────┬─────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
              live shell dock     /shell inspector   background_shell
                    │                  │                  │
                    └──────────────────┴──────────────────┘
                                       │
                                       ▼
                            completion steer to agent
```

Foreground jobs never enter the shell manager. Background jobs never create a fake streaming transcript row. Each path has one source of truth.

## Output retention

The manager keeps a bounded tail of large outputs in memory. Once Pi's output-tail limits are exceeded, the complete raw stream is spilled to a temporary log file while the retained tail remains available for status, inspection, and completion reporting.

The `/shell` inspector reads the emulated terminal screen rather than dumping that raw file, so interactive terminal-style output remains readable.

## Session lifecycle

Shell state follows the Pi session lifecycle.

- Completed, failed, and killed job snapshots can be restored with the session branch.
- Switching session trees clears the current in-memory view and restores the selected branch's shell snapshot.
- Running background processes are aborted when the Pi session shuts down; this extension is not a daemon and does not let commands outlive their owning Pi session.
- Extension reloads explicitly rebuild subscriptions so stale listeners do not duplicate dock renders or completion notifications.

## Coexists with other Pi UI

The dock uses Pi's standard `belowEditor` widget placement and its own widget key. It can coexist with other extensions using the same placement, including agent-status surfaces such as `pi-subagents`.

It does not replace Pi's editor, transcript, or built-in foreground bash renderer.

## Development

The repository includes unit tests, integration tests, and a real interactive Pi TUI observer driven by an offline scripted provider.

```bash
npm install

npm test
npm run typecheck
```

Launch the interactive demo:

```bash
npm run tui:demo
```

Useful observer scenarios:

```bash
# Foreground + background selection in one run
npm run tui:demo

# Walk through dock summary states and inspector scrolling
npm run tui:demo -- shelldocksum

# Show the shell dock beside a pi-subagents widget
npm run tui:demo -- subagent
```

The demo uses Pi itself for the TUI, tool plumbing, and execution, while a local faux provider scripts the model turns. It runs offline and is intended for visually verifying the surfaces that headless tests cannot meaningfully judge.

## Compatibility

The current codebase targets the Pi `0.86.x` API line and is written as a TypeScript Pi package.

## License

ISC
