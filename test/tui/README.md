# Real pi TUI observer (`test/tui`)

`npm test` drives the registered `bash` tool headlessly through `test/harness.ts` (unit tests in
`test/unit`, integration tests in `test/integration`) and asserts what a caller observes. This
directory adds the other half: the same extension observed inside a real, interactive pi session,
driven by a scripted model. It asserts nothing - the human watching the TUI decides whether the
screen looks right.

What is real and what is scripted:

| | real | scripted |
| --- | --- | --- |
| session | pi itself, interactive TUI, real agent loop, real tool-result plumbing | the model: pi-ai's `fauxProvider()`, which answers from this directory's scripts |
| extension | `src/index.ts`, loaded with `-e`: announces the command, then delegates | — |
| execution | pi's built-in `bash` tool spawns and streams the fixture command | — |
| rendering | pi's own TUI and its built-in bash renderers, merged by tool name (the extension ships none) | — |
| network | nothing: `--offline`, no API key, no provider request | — |

Two scenarios exist:

| scenario | command | what it shows |
| --- | --- | --- |
| `fixture` (default) | `npm run tui:demo [-- <fixture-id>]` | one scripted `bash` call and how the row and the shell dock behave |
| `subagent` | `npm run tui:demo -- subagent` | a `bash` call and a foreground subagent running at the same time, so the shell dock and pi-subagents' own widget share the below-editor area |

## Files

- `scripted-provider.ts` – pi extension for the fixture scenario. Registers `fauxProvider()` and
  queues exactly two responses: a `fauxToolCall("bash", { command[, timeout] })` with
  `stopReason: "toolUse"`, then the closing line `fixture finished`.
- `subagent-scenario.ts` – pi extension for the subagent scenario. Registers the same faux provider
  and, during `session_start`, registers the offline probe agent `pi-shell-view-probe` with
  pi-subagents through the `pi-subagents:runtime-agent-register:v1` event. Its scripted responses
  come from one factory that tells the parent and the probe apart by a marker in the probe's system
  prompt, so the order does not depend on how the two sessions interleave:
  1. parent turn 1 – two sibling tool calls: `bash` (the long command) and
     `subagent({ agent: "pi-shell-view-probe", task: ..., async: false })`;
  2. probe turn 1 – its own long `bash` command; turn 2 – `probe finished`;
  3. parent turn 2 – `fixture finished`.
- `launch.ts` – starts `pi` with the scenario's extensions loaded and stdio inherited, so the TUI
  draws in your terminal (or in the pty you capture). It forwards the `PI_SHELL_VIEW_*` variables and
  the child's exit code, validates the fixture id and resolves pi-subagents before launching.

pi is invoked as (absolute paths come from `import.meta.url`):

```
# fixture scenario
pi --no-extensions -e <repo>/test/tui/scripted-provider.ts -e <repo>/src/index.ts \
   --provider faux --model faux-1 --no-session -nc -np -ns --offline "run the shell-view fixture"

# subagent scenario
pi --no-extensions -e <repo>/test/tui/subagent-scenario.ts -e <pi-subagents>/index.js -e <repo>/src/index.ts \
   --provider faux --model faux-1 --no-session -nc -np -ns --offline "run the shell-view subagent fixture"
```

pi-subagents is resolved in this order: `PI_SUBAGENTS_EXTENSION`, `<repo>/node_modules/pi-subagents`,
then `~/.pi/agent/npm/node_modules/pi-subagents` (where `pi install` puts user-scope packages). If
none exists the launcher reports the missing paths and exits non-zero instead of starting a session
without a subagent.

## Run it

```
npm run tui:demo                          # default fixture: progress
npm run tui:demo -- failing               # any fixture id from test/fixtures/long-running-scripts.ts
npm run tui:demo -- subagent              # shell dock + pi-subagents widget at the same time
npm run tui:demo -- --help                # usage text, exit code 0
PI_SHELL_VIEW_COMMAND="ls -la" npm run tui:demo
PI_SHELL_VIEW_FIXTURE=log-stream npm run tui:demo
PI_SHELL_VIEW_TIMEOUT=5 npm run tui:demo -- flood
PI_SHELL_VIEW_COMMAND="sleep 30" PI_SHELL_VIEW_PROBE_COMMAND="sleep 25" npm run tui:demo -- subagent
```

Fixture selection precedence: positional argument → `PI_SHELL_VIEW_FIXTURE` → `progress`.
`PI_SHELL_VIEW_COMMAND` replaces the parent command outright; in the subagent scenario
`PI_SHELL_VIEW_PROBE_COMMAND` replaces the probe's command (default `sleep 25`) and
`PI_SHELL_VIEW_COMMAND` keeps the parent's (default `sleep 30`). `PI_SHELL_VIEW_TIMEOUT` becomes the
bash tool's timeout in seconds. An unknown fixture id or a non-positive timeout makes the extension
fail while loading, so pi reports the error and exits non-zero instead of running something else.

The session stays interactive; quit it with `Ctrl+D`, `Ctrl+C` or `/quit`.

## What to watch for

The extension only announces the command and delegates the call, so nearly everything on screen is
pi:

1. `command: <command>` – the extension's own `ctx.ui.notify` announcement before the command
   starts, which today arrives as a `Warning: ...` toast. It is deliberately debug output (more
   debuglog calls are expected), not the dock: the `  Shells · …` line below the editor is the
   surface the extension is about. No test asserts these announcements, so adding more cannot break
   `npm test`.
2. `$ <command>` – the tool row, drawn by pi's built-in bash renderer (bold prompt and command, plus
   a muted `(timeout Ns)` suffix when `PI_SHELL_VIEW_TIMEOUT` set a timeout).
3. output streaming in – pi redraws the row while the built-in tool reports `onUpdate` snapshots.
   Collapsed, the row shows only the last output lines with a `Ctrl+O` expand hint; both the hint and
   the row layout come from pi, not from the extension.
4. the settled row – the fixture's output, followed by a truncation warning carrying the full output
   path for `flood`, and the elapsed time. For `failing` the row reports the failure instead, ending
   in the built-in `Command exited with code 3` message. A bash tool timeout is reported as
   `Command timed out after N seconds`: `PI_SHELL_VIEW_TIMEOUT=1 npm run tui:demo -- progress` kills
   the two-second fixture after one second and shows exactly that.
5. `  Shells · …` – the shell dock below the editor: `N shells`, the per-status counts and the latest
   running command, mounted under the widget key `pi-shell-view` with `placement: "belowEditor"`.
6. `fixture finished` – the scripted model's closing line, once the tool result came back.

In the subagent scenario the interesting moment is step 3 of the parent command, while the probe is
still running. The below-editor area then shows two lines from two extensions:

```
──────────────────────────────────────────────────────────
   Shells · 1 shells · 1 running · sleep 30                 ← pi-shell-view (this extension)
  1 active agent · ↓ 1.2k window · ↓/← to inspect           ← pi-subagents fleet surface
~/.pi/agent/local-extensions/pi-shell-view (main)
↑7.2k ↓33 W7.2k CH0.0% 11.2%/128k (auto)     (faux) faux-1
```

Both use `placement: "belowEditor"` under different widget keys, so pi keeps them side by side. Note
that pi re-inserts a widget whenever its key is set again, so the line that rendered last is drawn
last; the order of the two lines may therefore change while the command runs. That is pi behaviour,
not a conflict between the extensions - the automated coexistence contract is asserted in
`test/integration/subagent-widget.test.ts`.

## Capturing the TUI as evidence

`script` gives pi a pty; the `(sleep 20)` keeps stdin open so pi stays interactive until `timeout`
kills it (exit code 124, which is expected for these runs).

```
(sleep 20) | timeout 35 script -q /tmp/pisv-tui-progress.log npm run tui:demo -- progress >/dev/null 2>&1
(sleep 20) | timeout 35 script -q /tmp/pisv-tui-failing.log  npm run tui:demo -- failing  >/dev/null 2>&1
(sleep 45) | timeout 60 script -q /tmp/pisv-tui-subagent.log \
  env PI_SHELL_VIEW_COMMAND="sleep 30" PI_SHELL_VIEW_PROBE_COMMAND="sleep 25" \
  npm run tui:demo -- subagent >/dev/null 2>&1
```

The log is raw terminal output: it contains redraw escape sequences and lines wrapped to the pty
width, so read it (stripping `\x1b\[[0-9;?]*[a-zA-Z]` makes it readable) instead of expecting exact
full-screen lines. This capture is a way to keep evidence for a human reader, not an automatic gate:
nothing in this directory fails a build, `npm test` asserts the delegation and shell-dock contracts,
and only a person can judge whether the TUI looked right.

## Scripted-session limits

Each scenario holds only the responses it queues. Ask anything after the scripted turns are
exhausted and pi answers `Error: No more faux responses queued`; restart `npm run tui:demo` to run a
scenario again.
