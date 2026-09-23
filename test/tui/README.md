# Real pi TUI observer (`test/tui`)

`npm test` drives the registered `bash` tool headlessly (`test/unit`, `test/integration`) and asserts
what a caller observes. This directory adds the other half: the same extension in a real interactive
pi session, driven by a scripted model. Nothing is asserted here - the human watching the TUI decides.

| | real | scripted |
| --- | --- | --- |
| session | pi itself: interactive TUI, agent loop, tool-result plumbing | the model: pi-ai's `fauxProvider()`, answering from this directory's scripts |
| extension | `src/index.ts` loaded with `-e`: delegates foreground calls, starts background jobs | — |
| execution | pi's built-in `bash` tool spawns and streams the fixture command (or the local bash operations stream into a shell job) | — |
| rendering | pi's own TUI; the wrapper delegates foreground rows to the built-in bash renderers and draws background rows empty | — |
| network | nothing: `--offline`, no API key, no provider request | — |

## Scenarios

| scenario | command | shows |
| --- | --- | --- |
| `selection` (default) | `npm run tui:demo` | the model's mode choice: a quick call in the foreground, a long one in the background with dock + `/shell` inspector |
| `fixture` | `npm run tui:demo -- <fixture-id>` | one scripted `bash` call: the row for a foreground call, the dock for a background one (`PI_SHELL_VIEW_MODE=background`) |
| `shelldocksum` | `npm run tui:demo -- shelldocksum` | every dock summary shape in one run, plus the `/shell` inspector scroll demo |
| `subagent` | `npm run tui:demo -- subagent` | a background `bash` call and a foreground subagent running together: shell dock + pi-subagents widget side by side |

- `bash-selection-scenario.ts` (`selection`, the default) queues two tool turns plus a closing text:
  first a quick command whose result the turn needs, sent without a mode (foreground delegation);
  then the long-running fixture sent with `mode: "background"`, so it becomes a shell job that the
  dock and the `/shell` inspector show while it streams. The closing text waits for the job to
  settle, so the inspector can also be read on a finished shell. `PI_SHELL_VIEW_FIXTURE`,
  `PI_SHELL_VIEW_COMMAND` and `PI_SHELL_VIEW_TIMEOUT` change what runs in the background.
- `scripted-provider.ts` (`fixture`) queues exactly two responses: a `fauxToolCall("bash", {
  command[, timeout][, mode] })` with `stopReason: "toolUse"`, then `fixture finished`. The default
  mode is foreground, so the row streams; `PI_SHELL_VIEW_MODE=background` turns the same call into a
  managed shell job and moves the observation to the dock and `/shell`.
- `shelldock-summary-scenario.ts` (`shelldocksum`) queues four turns of *background* bash calls - the
  `long-output` fixture alone (200 streaming lines, longer than the inspector's pane), a long `sleep`
  next to a `sleep` that a two-second timeout fails, then two settling sleeps - walking the dock
  through one running, one completed, mixed counts and a failed shell. It notifies `press /shell to
  scroll this output (⇧↑/⇧↓, Home/End)` when the long fixture starts. The sequence is fixed; observer
  variables do not change it.
- `subagent-scenario.ts` (`subagent`) registers the same faux provider plus, at `session_start`, the
  offline probe agent `pi-shell-view-probe` (through `pi-subagents:runtime-agent-register:v1`). One
  response factory tells parent from probe by a marker in the probe's system prompt, so interleaving
  does not matter: parent turn 1 asks for sibling background `bash` and foreground
  `subagent({ async: false })` calls, the probe runs its own long foreground `bash` then `probe
  finished`, parent turn 2 closes with `fixture finished`.
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
npm run tui:demo                          # default scenario: selection (foreground + background)
npm run tui:demo -- progress              # single fixture call: progress (foreground row)
npm run tui:demo -- failing               # any fixture id from test/fixtures/long-running-scripts.ts
npm run tui:demo -- shelldocksum          # every shell dock summary shape, one after another
npm run tui:demo -- subagent              # shell dock + pi-subagents widget at the same time
npm run tui:demo -- --help                # usage text, exit code 0
PI_SHELL_VIEW_COMMAND="ls -la" npm run tui:demo
PI_SHELL_VIEW_MODE=background npm run tui:demo -- flood
PI_SHELL_VIEW_FIXTURE=log-stream npm run tui:demo
PI_SHELL_VIEW_TIMEOUT=5 npm run tui:demo -- flood
PI_SHELL_VIEW_COMMAND="sleep 30" PI_SHELL_VIEW_PROBE_COMMAND="sleep 25" npm run tui:demo -- subagent
```

- Selection: positional argument first, then `PI_SHELL_VIEW_SCENARIO`; anything that is not a
  scenario id is a fixture id. With nothing selected at all the launcher runs the `selection`
  scenario; a positional fixture id or `PI_SHELL_VIEW_FIXTURE` (default `progress`) runs the
  single-call fixture scenario, where the fixture variables apply.
- `PI_SHELL_VIEW_COMMAND` replaces the command outright; in the subagent scenario it replaces the
  parent's (default `sleep 30`, run in the background) and `PI_SHELL_VIEW_PROBE_COMMAND` the probe's
  (default `sleep 25`, foreground). `PI_SHELL_VIEW_TIMEOUT` becomes the bash tool's timeout in
  seconds. `PI_SHELL_VIEW_MODE` is `foreground` (default) or `background` in the fixture scenario.
- An unknown fixture id, an unknown mode or a non-positive timeout fails while the extension loads,
  so pi reports the error and exits non-zero instead of running something else.
- pi-subagents is resolved at `PI_SUBAGENTS_EXTENSION`, then `<repo>/node_modules/pi-subagents`, then
  `~/.pi/agent/npm/node_modules/pi-subagents` (where `pi install` puts user-scope packages); if none
  exists the launcher reports the missing paths and exits non-zero.

The session stays interactive; quit with `Ctrl+D`, `Ctrl+C` or `/quit`.

## What to watch for

### `selection` (default)

The scripted model picks the mode, so one run shows both paths in order:

1. turn 1 - the model says it needs the result before continuing and sends the quick command
   *without* a mode: the `$ <command>` row streams and settles like a plain bash call and the
   extension records nothing (no dock line, no `/shell` job).
2. turn 2 - the model decides the long fixture may continue on its own and sends
   `mode: "background"`: the call leaves no transcript row at all (the tool answered before the
   command ran, and the job streams only into the dock), the dock appears with
   `1 running shell · <command> · <Ns> · /shell to open` and the seconds ticking, and `/shell` shows
   the same job while its output pane grows. Open `/shell` here and follow the pane at the tail
   (or `⇧↑` to pause it).
3. the closing text arrives after the shell settled, so the dock turns into
   `1 shell completed in <Ns> · /shell to open` and `/shell` still lists the finished job with its
   complete output.

The background command is the `long-output` fixture by default (200 lines, longer than the
inspector's pane); `PI_SHELL_VIEW_FIXTURE`, `PI_SHELL_VIEW_COMMAND` and `PI_SHELL_VIEW_TIMEOUT`
change what runs in the background.

### `fixture` runs

Foreground is the default path, so nearly everything on screen is pi:

1. `$ <command>` - the tool row, drawn by pi's built-in bash renderer (bold prompt and command, plus
   a muted `(timeout Ns)` suffix when `PI_SHELL_VIEW_TIMEOUT` set a timeout).
2. output streaming in - pi redraws the row from the built-in tool's `onUpdate` snapshots; collapsed,
   the row shows the last lines plus a `Ctrl+O` expand hint. Hint and layout come from pi.
3. the settled row - the fixture's output, a truncation warning carrying the full output path for
   `flood`, and the elapsed time. For `failing` the row reports the failure instead, ending in
   `Command exited with code 3`; a bash tool timeout ends in `Command timed out after N seconds`
   (`PI_SHELL_VIEW_TIMEOUT=1 npm run tui:demo -- progress` kills the two-second fixture after one
   second and shows exactly that).
4. no dock and no `/shell` job - a foreground call is a pure delegation; the extension records
   nothing. `npm run tui:demo` (the `selection` scenario) and `shelldocksum` are the runs that
   populate them.

With `PI_SHELL_VIEW_MODE=background` the same fixture becomes a managed shell job:

1. no transcript row - the call settles immediately (the tool answered before the command
   finished) and the wrapper draws both the call and its result as empty, because the job is
   reported by the dock and `/shell` instead.
2. `1 running shell · <command> · <Ns> · /shell to open` - the shell dock below the editor, mounted
   under widget key `pi-shell-view` with `placement: "belowEditor"`, with the seconds ticking while
   the command runs.
3. `1 shell completed in <Ns> · /shell to open` - the same job after it exited with code 0. A
   non-zero exit fails the job with its exit code and reason instead, and the dock reports it in
   the count list, like a timeout does with its own reason.
4. `/shell` shows the job's output pane, which grows while the command streams and can be scrolled
   (`⇧↑`/`⇧↓`, `Home`/`End`; the Output header reports `paused ↑N` while the newest line is out of
   view).

In `shelldocksum` the dock alone tells the story, in this order (about 7.5s + 3s + 4s):

```
1 running shell · bash /…/long-output.sh · 0s · /shell to open    ← turn 1, one shell alone (200 lines stream in)
1 shell completed in 6s · /shell to open
3 shells · 2 running · 1 completed · /shell to open               ← turn 2, mixed list
3 shells · 1 running · 1 completed · 1 failed · /shell to open    ← the two-second timeout failed one shell
5 shells · 3 running · 1 completed · 1 failed · /shell to open    ← turn 3, two more sleeps
5 shells · 4 completed · 1 failed · /shell to open                ← everything settled
```

The automated shape of these lines (with the `failed` status the manager still supports) is asserted
in `test/unit/shell-dock.test.ts`; which statuses a real call can produce is asserted in
`test/integration/background-bash.test.ts`.

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
(sleep 20) | timeout 35 script -q /tmp/pisv-tui-selection.log npm run tui:demo >/dev/null 2>&1
(sleep 20) | timeout 35 script -q /tmp/pisv-tui-progress.log npm run tui:demo -- progress >/dev/null 2>&1
(sleep 20) | timeout 35 script -q /tmp/pisv-tui-background.log env PI_SHELL_VIEW_MODE=background npm run tui:demo -- progress >/dev/null 2>&1
(sleep 20) | timeout 35 script -q /tmp/pisv-tui-failing.log  npm run tui:demo -- failing  >/dev/null 2>&1
(sleep 30) | timeout 45 script -q /tmp/pisv-tui-shelldocksum.log npm run tui:demo -- shelldocksum >/dev/null 2>&1
(sleep 45) | timeout 60 script -q /tmp/pisv-tui-subagent.log \
  env PI_SHELL_VIEW_COMMAND="sleep 30" PI_SHELL_VIEW_PROBE_COMMAND="sleep 25" \
  npm run tui:demo -- subagent >/dev/null 2>&1
```

The log is raw terminal output - redraw escapes and pty-wrapped lines; strip `\x1b\[[0-9;?]*[a-zA-Z]`
and read it as loose lines. This is evidence for a human reader, not an automatic gate: nothing here
fails a build, and the headless tests own the contracts.

`script` forwards its stdin, so the same recipe can type keystrokes. This one follows the selection
scenario and opens the inspector on the background shell while it streams:

```
(sleep 3; printf '/shell\r'; sleep 3; printf '\x1b'; sleep 3; printf '\x03'; sleep 2) \
  | timeout 40 script -q /tmp/pisv-tui-selection-inspector.log npm run tui:demo >/dev/null 2>&1
```

Look for the foreground row settling first, then no row at all for the background call, the
`1 running shell · ... · /shell to open` dock line, and the inspector frame with the growing output
pane (`Output · <N> lines · running`). The keystroke recipe below is the shelldocksum variant that
pauses and scrolls the `long-output` pane:

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
again. Background shells are owned by the extension, which aborts them on session shutdown, so a
background command does not outlive the pi session that started it.
