/**
 * Launcher for the real-pi-TUI observer of pi-shell-view.
 *
 * Starts the real `pi` binary in interactive mode, loading this directory's scripted provider plus
 * the repository's `src/index.ts`. A deterministic faux model then asks for bash tool calls, which
 * pi's built-in bash tool executes for real: the extension either delegates a foreground call
 * unchanged and draws and streams the row with the built-in bash renderers, or starts a background
 * call that returns immediately, leaves no transcript row and shows up in the shell dock. The child
 * inherits stdio, so it draws into the caller's terminal (or
 * into the pty created by `script`), and its exit code is forwarded unchanged.
 *
 * Four scenarios exist:
 *
 * - `selection` (default): `bash-selection-scenario.ts` scripts two turns that show how a model
 *   should choose the execution mode - a quick command whose result the turn needs is delegated in
 *   the foreground, and a long task that may continue independently runs in the background and
 *   appears in the dock and the `/shell` inspector.
 * - `fixture`: one scripted bash call, for the row's (foreground, default) or the dock's
 *   (background, `PI_SHELL_VIEW_MODE=background`) behaviour. Selected with a fixture id.
 * - `shelldocksum`: `shelldock-summary-scenario.ts` queues four scripted turns of background bash
 *   calls that walk the dock through every summary shape (one running, one completed, mixed counts,
 *   a failed shell), so the line can be read in the real TUI. Its first turn streams the
 *   `long-output` fixture, whose 200 lines overflow the `/shell` inspector's pane, so the same run
 *   also verifies the inspector's scroll keys by hand.
 * - `subagent`: `subagent-scenario.ts` registers the same faux provider plus an offline probe agent,
 *   and its first scripted turn asks for a background bash call and a foreground subagent call at
 *   once. The shell job returns immediately while the subagent keeps running, so the shell dock and
 *   pi-subagents' own below-editor widget are on screen together - the observation this scenario
 *   exists for. The pi-subagents extension is found through `PI_SUBAGENTS_EXTENSION`, the
 *   repository's `node_modules`, or the user package directory.
 *
 * Observation only: nothing here asserts anything, the human watching the screen does.
 *
 * Usage: npm run tui:demo [-- <fixture-id>|selection|shelldocksum|subagent]
 *        PI_SHELL_VIEW_COMMAND=... npm run tui:demo
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fixture driven when neither the positional argument nor `PI_SHELL_VIEW_FIXTURE` is given. */
const DEFAULT_FIXTURE_ID = "progress";

/** Default scenario: the two execution modes chosen side by side. */
const BASH_SELECTION_SCENARIO = "selection";

/** Scenario id that additionally loads pi-subagents and drives one foreground subagent. */
const SUBAGENT_SCENARIO = "subagent";

/** Scenario id that walks the shell dock through every summary shape. */
const SHELLDOCK_SUMMARY_SCENARIO = "shelldocksum";

/** Observer variables read by the scenario scripts; forwarded to the child process. */
const PI_SHELL_VIEW_VARS = [
    "PI_SHELL_VIEW_SCENARIO",
    "PI_SHELL_VIEW_FIXTURE",
    "PI_SHELL_VIEW_COMMAND",
    "PI_SHELL_VIEW_MODE",
    "PI_SHELL_VIEW_PROBE_COMMAND",
    "PI_SHELL_VIEW_TIMEOUT",
] as const;

const USAGE = `Usage: npm run tui:demo [-- <fixture-id>|selection|shelldocksum|subagent]
       PI_SHELL_VIEW_COMMAND=... npm run tui:demo

Starts the real pi TUI with a scripted faux model and the extension in src/index.ts; the model asks
for real bash tool calls. A foreground call (mode omitted) is delegated to pi's built-in bash tool,
which pi draws with its built-in bash renderers; a background call (mode: "background") returns
immediately and appears in the shell dock below the editor and in the /shell inspector.

The default scenario shows the model's mode selection: a quick command whose result the turn needs
runs in the foreground, a long task that may continue independently runs in the background.

  npm run tui:demo                        # default scenario: ${BASH_SELECTION_SCENARIO}
  npm run tui:demo -- progress            # single fixture call: ${DEFAULT_FIXTURE_ID} in the foreground
  npm run tui:demo -- failing             # fixture id from test/fixtures/long-running-scripts.ts
  npm run tui:demo -- shelldocksum        # every shell dock summary shape, one after another
  npm run tui:demo -- subagent            # shell dock + pi-subagents widget at the same time
  PI_SHELL_VIEW_COMMAND="ls -la" npm run tui:demo
  PI_SHELL_VIEW_MODE=background npm run tui:demo -- flood
  PI_SHELL_VIEW_TIMEOUT=5 npm run tui:demo -- flood

The subagent scenario needs pi-subagents: it is looked up at PI_SUBAGENTS_EXTENSION, then
<repo>/node_modules/pi-subagents/index.js, then ~/.pi/agent/npm/node_modules/pi-subagents/index.js.
It runs an offline probe agent (registered by test/tui/subagent-scenario.ts) whose own bash command
is configurable with PI_SHELL_VIEW_PROBE_COMMAND; the parent's background bash command stays
PI_SHELL_VIEW_COMMAND.

What to watch for in the selection scenario (default):

1. turn 1 is the foreground case - the scripted model says it needs the result before continuing and
   sends the call without a mode, so the "$ <command>" row streams and settles like a plain bash
   call and no dock entry or /shell job appears.
2. turn 2 is the background case - the model decides the long fixture can continue on its own and
   sends mode: "background", so the call leaves no transcript row (the wrapper draws it empty), the
   dock shows "1 running shell · <command> · <Ns> · /shell to open" with the seconds ticking, and
   /shell shows the same job with its output pane growing while it streams. Press /shell here to
   scroll the pane (⇧↑/⇧↓, Home/End) while the shell runs.
3. the closing text arrives after the shell settled, so the dock turns into
   "1 shell completed in <Ns> · /shell to open" and /shell still shows the finished job.

The background command is the long-output fixture by default; PI_SHELL_VIEW_FIXTURE,
PI_SHELL_VIEW_COMMAND and PI_SHELL_VIEW_TIMEOUT change what runs in the background.

What to watch for in a fixture run ("npm run tui:demo -- <id>" or PI_SHELL_VIEW_FIXTURE=<id>):
foreground (the default) draws the "$ <command>" row pi streams and settles - success, truncation
warning or the failure text for a failing fixture - with no dock entry. With
PI_SHELL_VIEW_MODE=background the same fixture runs as a managed shell job instead: the transcript
row stays empty, the dock reports the job, and /shell shows it. A non-zero exit fails the job
carrying its exit code, like a timeout does with its own reason.

What to watch for in the shelldocksum scenario: the dock below the editor walks through its summary
shapes without any keyboard input - "1 running shell · <command> · <Ns> · /shell to open" with the
seconds ticking, then "1 shell completed in <Ns> · /shell to open", then the count list of a mixed
list ("3 shells · 2 running · 1 completed · /shell to open" ... "3 shells · 1 running ·
1 completed · 1 failed · /shell to open"), and finally "5 shells · 4 completed · 1 failed ·
/shell to open".

The first turn is the inspector's scroll demo: the long-output fixture streams 200 lines, notifies
"press /shell to scroll this output (⇧↑/⇧↓, Home/End)" when it starts, and its output is longer than
the inspector's pane on any terminal. Press /shell while it runs to watch the pane follow the newest
line, then scroll back with Shift+Up/Shift+K, forward with Shift+Down/Shift+J and jump with Home/End:
the Output header shows "paused ↑N" while the newest line is out of view and drops it again once the
pane is back at the tail. The job stays in the list after it completes, so the same scrolling can be
checked on a settled shell.

What to watch for in the subagent scenario: the shell dock line "1 running shell · <command> ·
<Ns> · /shell to open" below the editor while the subagent runs, pi-subagents' own widget next to it,
and both disappearing as their runs settle ("fixture finished" and "probe finished").

pi loads the extensions and stays interactive; quit it with Ctrl+D, Ctrl+C or /quit. The scripted
session holds only the queued responses, so any further turn answers "No more faux responses queued".
`;

/** Absolute path of a file named relative to this launcher, for pi's `-e` flag. */
function repoFile(relativePath: string): string {
    return fileURLToPath(new URL(relativePath, import.meta.url));
}

/** First positional argument, used as a fixture id or as the scenario id. */
function positional(argv: string[]): string | undefined {
    return argv[0];
}

/** Scenario named by the positional argument or `PI_SHELL_VIEW_SCENARIO`, if any. */
type TuiScenario =
    | typeof BASH_SELECTION_SCENARIO
    | typeof SHELLDOCK_SUMMARY_SCENARIO
    | typeof SUBAGENT_SCENARIO;

/** Every scenario id the launcher knows; anything else is treated as a fixture id. */
function isScenario(selection: string | undefined): selection is TuiScenario {
    return selection === BASH_SELECTION_SCENARIO ||
        selection === SHELLDOCK_SUMMARY_SCENARIO ||
        selection === SUBAGENT_SCENARIO;
}

/**
 * Scenario of this run.
 *
 * A positional or `PI_SHELL_VIEW_SCENARIO` scenario id wins; a positional or `PI_SHELL_VIEW_FIXTURE`
 * fixture id keeps the single-call fixture scenario; with nothing selected at all the default is the
 * scenario that shows foreground/background selection.
 */
function selectedScenario(argv: string[]): TuiScenario | undefined {
    const selection = positional(argv) ?? process.env.PI_SHELL_VIEW_SCENARIO;
    if (isScenario(selection)) {
        return selection;
    }

    if (positional(argv) !== undefined || process.env.PI_SHELL_VIEW_FIXTURE !== undefined) {
        return undefined;
    }

    return BASH_SELECTION_SCENARIO;
}

/** Fixture id of this run: positional argument first, then `PI_SHELL_VIEW_FIXTURE`, then the default. */
function fixtureId(argv: string[]): string {
    return positional(argv) ?? process.env.PI_SHELL_VIEW_FIXTURE ?? DEFAULT_FIXTURE_ID;
}

/**
 * Absolute path of the installed pi-subagents extension entry, or an error explaining what to do.
 *
 * pi installs user-scope npm packages under `~/.pi/agent/npm`, so both that directory and the
 * repository's own `node_modules` are checked before giving up.
 */
function resolveSubagentExtension(): string {
    const override = process.env.PI_SUBAGENTS_EXTENSION;
    if (override !== undefined) {
        if (!existsSync(override)) {
            throw new Error(`PI_SUBAGENTS_EXTENSION points at a missing file: ${override}`);
        }
        return override;
    }

    const candidates = [
        repoFile("../../node_modules/pi-subagents/index.js"),
        join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents", "index.js"),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
        throw new Error(
            `the subagent scenario needs pi-subagents, but none of these exists:\n${candidates
                .map((candidate) => `  - ${candidate}`)
                .join("\n")}\nInstall it with "pi install npm:pi-subagents" or set PI_SUBAGENTS_EXTENSION to its index.js.`,
        );
    }
    return found;
}

/** Child environment: the launcher's environment with the observer variables copied across. */
function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of PI_SHELL_VIEW_VARS) {
        const value = process.env[name];
        if (value !== undefined) {
            env[name] = value;
        }
    }
    return env;
}

/** Extensions pi loads for a scenario, in load order; the fixture scenario needs no scenario extension. */
function scenarioExtensions(scenario: TuiScenario | undefined): string[] {
    switch (scenario) {
        case BASH_SELECTION_SCENARIO:
            return [repoFile("bash-selection-scenario.ts"), repoFile("../../src/index.ts")];
        case SUBAGENT_SCENARIO:
            return [repoFile("subagent-scenario.ts"), resolveSubagentExtension(), repoFile("../../src/index.ts")];
        case SHELLDOCK_SUMMARY_SCENARIO:
            return [repoFile("shelldock-summary-scenario.ts"), repoFile("../../src/index.ts")];
        default:
            return [repoFile("scripted-provider.ts"), repoFile("../../src/index.ts")];
    }
}

function main(): void {
    const argv = process.argv.slice(2);
    if (argv[0] === "--help" || argv[0] === "-h") {
        process.stdout.write(USAGE);
        return;
    }

    const scenario = selectedScenario(argv);
    const extensions = scenarioExtensions(scenario);

    const args = [
        "--no-extensions",
        ...extensions.flatMap((extension) => ["-e", extension]),
        "--provider",
        "faux",
        "--model",
        "faux-1",
        "--no-session",
        "-nc",
        "-np",
        "-ns",
        "--offline",
        scenario === SUBAGENT_SCENARIO
            ? "run the shell-view subagent fixture"
            : scenario === SHELLDOCK_SUMMARY_SCENARIO
                ? "run the shell-view dock summary fixture"
                : scenario === BASH_SELECTION_SCENARIO
                    ? "run the shell-view bash selection fixture"
                    : "run the shell-view fixture",
    ];

    const child = spawn("pi", args, {
        stdio: "inherit",
        // Only the fixture scenario reads the fixture id; a scenario ignores it.
        env: scenario === undefined ? { ...childEnv(), PI_SHELL_VIEW_FIXTURE: fixtureId(argv) } : childEnv(),
    });

    child.on("error", (error) => {
        process.stderr.write(`tui:demo could not start pi: ${error.message}\n`);
        process.exitCode = 1;
    });

    child.on("exit", (code, signal) => {
        if (code !== null) {
            process.exitCode = code;
            return;
        }
        // Killed by a signal (for example the pty harness hitting its timeout): there is no exit code
        // to forward, so report the failure instead of looking successful.
        process.stderr.write(`tui:demo: pi was terminated by signal ${signal ?? "unknown"}\n`);
        process.exitCode = 1;
    });
}

try {
    main();
} catch (error) {
    process.stderr.write(`tui:demo: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
