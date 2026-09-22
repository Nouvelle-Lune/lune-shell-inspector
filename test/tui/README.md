# Real pi TUI observer (`test/tui`)

`npm test` drives the registered `bash` tool headlessly (`test/unit`, `test/integration`) and asserts
what a caller observes. This directory adds the other half: the same extension in a real interactive
pi session, driven by a scripted model. Nothing is asserted here - the human watching the TUI decides.

| | real | scripted |
| --- | --- | --- |
| session | pi itself: interactive TUI, agent loop, tool-result plumbing | the model: pi-ai's `fauxProvider()`, answering from this directory's scripts |
| extension | `src/index.ts` loaded with `-e`: announces the command, then delegates | — |
| execution | pi's built-in `bash` tool spawns and streams the fixture command | — |
| rendering | pi's own TUI and built-in bash renderers, merged by tool name (the extension ships none) | — |
| network | nothing: `--offline`, no API key, no provider request | — |

## Scenarios

| scenario | command | shows |
| --- | --- | --- |
| `fixture` (default) | `npm run tui:demo [-- <fixture-id>]` | one scripted `bash` call: how the row and the shell dock behave |
| `shelldocksum` | `npm run tui:demo -- shelldocksum` | every dock summary shape in one run, plus the `/shell` inspector scroll demo |
| `subagent` | `npm run tui:demo -- subagent` | a `bash` call and a foreground subagent running together: shell dock + pi-subagents widget side by side |

- `scripted-provider.ts` (`fixture`) queues exactly two responses: a `fauxToolCall("bash", {
  command[, timeout] })` with `stopReason: "toolUse"`, then `fixture finished`.
- `shelldock-summary-scenario.ts` (`shelldocksum`) queues three bash turns - the `long-output` fixture
  alone (200 streaming lines, longer than the inspector's pane), a long `sleep` next to the failing
  fixture, then two long sleeps abortable with Esc - walking the dock through one running, one
  completed, mixed counts, a failure and stopped shells. It notifies `press /shell to scroll this
  output (⇧↑/⇧↓, Home/End)` when the long fixture starts. The sequence is fixed; observer variables
  do not change it.
- `subagent-scenario.ts` (`subagent`) registers the same faux provider plus, at `session_start`, the
  offline probe agent `pi-shell-view-probe` (through `pi-subagents:runtime-agent-register:v1`). One
  response factory tells parent from probe by a marker in the probe's system prompt, so interleaving
  does not matter: parent turn 1 asks for sibling `bash` and `subagent({ async: false })` calls, the
  probe runs its own long `bash` then `probe finished`, parent turn 2 closes with `fixture finished`.
- `launch.ts` starts `pi` with the scenario's extensions loaded and stdio inherited, so the TUI draws
  in your terminal (or the pty you capture); it forwards the `PI_SHELL_VIEW_*` variables and the
  child's exit code, validates the fixture id and resolves pi-subagents before launching.

pi is invoked as below (absolute paths from `import.meta.url`); the subagent scenario inserts
`-e <pi-subagents>/index.js` before `src/index.ts`:

```
pi --no-extensions -e <repo>/test/tui/<scenario>.ts -e <repo>/src/index.ts \
   --provider faux --model faux-1 --no-session -nc -np -ns --offline "<prompt>"
```

## Run it

```sh
npm run tui:demo                          # default fixture: progress
npm run tui:demo -- failing               # any fixture id from test/fixtures/long-running-scripts.ts
npm run tui:demo -- shelldocksum          # every shell dock summary shape, one after another
npm run tui:demo -- subagent              # shell dock + pi-subagents widget at the same time
npm run tui:demo -- --help                # usage text, exit code 0
PI_SHELL_VIEW_COMMAND="ls -la" npm run tui:demo
PI_SHELL_VIEW_FIXTURE=log-stream npm run tui:demo
PI_SHELL_VIEW_TIMEOUT=5 npm run tui:demo -- flood
PI_SHELL_VIEW_COMMAND="sleep 30" PI_SHELL_VIEW_PROBE_COMMAND="sleep 25" npm run tui:demo -- subagent
```

- Selection: positional argument first, then `PI_SHELL_VIEW_FIXTURE` (default `progress`) or
  `PI_SHELL_VIEW_SCENARIO`; anything that is not a scenario id is a fixture id, and in a scenario run
  the fixture variables have no effect.
- `PI_SHELL_VIEW_COMMAND` replaces the command outright; in the subagent scenario it replaces the
  parent's (default `sleep 30`) and `PI_SHELL_VIEW_PROBE_COMMAND` the probe's (default `sleep 25`).
  `PI_SHELL_VIEW_TIMEOUT` becomes the bash tool's timeout in seconds.
- An unknown fixture id or non-positive timeout fails while the extension loads, so pi reports the
  error and exits non-zero instead of running something else.
- pi-subagents is resolved at `PI_SUBAGENTS_EXTENSION`, then `<repo>/node_modules/pi-subagents`, then
  `~/.pi/agent/npm/node_modules/pi-subagents` (where `pi install` puts user-scope packages); if none
  exists the launcher reports the missing paths and exits non-zero.

The session stays interactive; quit with `Ctrl+D`, `Ctrl+C` or `/quit`.

## What to watch for

The extension only announces the command and delegates, so nearly everything on screen is pi:

1. `Executing command: <command>` - the extension's `ctx.ui.notify` announcement before the command
   starts, which today arrives as a `Warning: ...` toast. Deliberately debug output (more debuglog
   calls are expected), not the dock: the `  Shells · …` line below the editor is the surface this
   extension is about. No test asserts these announcements, so adding more cannot break `npm test`.
2. `$ <command>` - the tool row, drawn by pi's built-in bash renderer (bold prompt and command, plus
   a muted `(timeout Ns)` suffix when `PI_SHELL_VIEW_TIMEOUT` set a timeout).
3. output streaming in - pi redraws the row from the built-in tool's `onUpdate` snapshots; collapsed,
   the row shows the last lines plus a `Ctrl+O` expand hint. Hint and layout come from pi.
4. the settled row - the fixture's output, a truncation warning carrying the full output path for
   `flood`, and the elapsed time. For `failing` the row reports the failure instead, ending in
   `Command exited with code 3`; a bash tool timeout ends in `Command timed out after N seconds`
   (`PI_SHELL_VIEW_TIMEOUT=1 npm run tui:demo -- progress` kills the two-second fixture after one
   second and shows exactly that).
5. `1 running shell · …` / `3 shells · …` - the shell dock below the editor, mounted under widget key
   `pi-shell-view` with `placement: "belowEditor"`. A single running shell shows its command, ticking
   seconds and `/shell to open`; a single completed one shows `1 shell completed in <Ns>`; otherwise
   it lists non-zero per-status counts. The `shelldocksum` first turn is the `/shell` inspector scroll
   demo: open the inspector while it streams and the output pane follows the newest line, then
   `Shift+Up`/`Shift+K`, `Shift+Down`/`Shift+J` and `Home`/`End` move it; the Output header reports
   `paused ↑N` until the newest line is back in view.
6. `fixture finished` - the scripted model's closing line, once the tool result came back.

In `shelldocksum` the dock alone tells the story, in this order (about 6s + 6s + 8s):

```
1 running shell · bash /…/long-output.sh · 0s · /shell to open    ← turn 1, one shell alone (200 lines stream in)
1 shell completed in 6s · /shell to open
3 shells · 2 running · 1 completed · /shell to open               ← turn 2, mixed list
3 shells · 1 running · 1 completed · 1 failed · /shell to open    ← the failing fixture landed
5 shells · 2 running · 2 completed · 1 failed · /shell to open    ← turn 3, two long sleeps
5 shells · 4 completed · 1 failed · /shell to open                ← both sleeps settled
```

Pressing Esc while the last two sleeps run aborts them, and the settled line then counts the stopped
shells (for example `5 shells · 2 completed · 1 failed · 2 stopped · /shell to open`). The automated
shape of every one of these lines is asserted in `test/unit/shell-dock.test.ts`.

In `subagent` the interesting moment is parent turn 1, while the probe is still running. The
below-editor area then shows two lines from two extensions:

```
   1 running shell · sleep 30 · 0s · /shell to open   ← pi-shell-view (this extension)
  1 active agent · ↓ 1.2k window · ↓/← to inspect     ← pi-subagents fleet surface
```

Both use `placement: "belowEditor"` under different widget keys, so pi keeps them side by side. pi
re-inserts a widget whenever its key is set again, so the two lines may swap order while the command
runs - pi behaviour, not a conflict between the extensions. The automated coexistence contract is
asserted in `test/integration/subagent-widget.test.ts`.

## Capturing the TUI as evidence

`script` gives pi a pty; the `(sleep N)` keeps stdin open so pi stays interactive until `timeout`
kills it (exit code 124, expected for these runs):

```
(sleep 20) | timeout 35 script -q /tmp/pisv-tui-progress.log npm run tui:demo -- progress >/dev/null 2>&1
(sleep 20) | timeout 35 script -q /tmp/pisv-tui-failing.log  npm run tui:demo -- failing  >/dev/null 2>&1
(sleep 30) | timeout 45 script -q /tmp/pisv-tui-shelldocksum.log npm run tui:demo -- shelldocksum >/dev/null 2>&1
(sleep 45) | timeout 60 script -q /tmp/pisv-tui-subagent.log \
  env PI_SHELL_VIEW_COMMAND="sleep 30" PI_SHELL_VIEW_PROBE_COMMAND="sleep 25" \
  npm run tui:demo -- subagent >/dev/null 2>&1
```

The log is raw terminal output - redraw escapes and pty-wrapped lines; strip `\x1b\[[0-9;?]*[a-zA-Z]`
and read it as loose lines. This is evidence for a human reader, not an automatic gate: nothing here
fails a build, and the headless tests own the contracts.

`script` forwards its stdin, so the same recipe can type keystrokes. This one opens the inspector
while `long-output` streams, pauses it, jumps around and closes it:

```
(sleep 3; printf '/shell\r'; sleep 1.5; printf '\x1b[1;2A\x1b[1;2A'; sleep 4; printf '\x1b[F'; sleep 1; \
  printf '\x1b'; sleep 1; printf '\x03'; sleep 2) \
  | timeout 60 script -q /tmp/pisv-tui-inspector.log npm run tui:demo -- shelldocksum >/dev/null 2>&1
```

Look for the `press /shell to scroll this output (⇧↑/⇧↓, Home/End)` notification when the fixture
starts, then the inspector frames: `Output · <N> lines · running` without a marker while the pane
follows the newest line, `paused ↑N` after `Shift+Up` with N growing as the run keeps streaming while
the visible lines stay put, `line 001` after `Home`, and the marker gone again after `End`.

## Scripted-session limits

Each scenario holds only the responses it queues. Ask anything after the scripted turns are exhausted
and pi answers `Error: No more faux responses queued`; restart `npm run tui:demo` to run a scenario
again.
