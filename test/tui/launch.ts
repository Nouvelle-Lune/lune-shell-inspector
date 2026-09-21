/**
 * Launcher for the real-pi-TUI observer of pi-shell-view.
 *
 * Starts the real `pi` binary in interactive mode, loading this directory's scripted provider plus
 * the repository's `src/index.ts`. A deterministic faux model then asks for exactly one bash tool
 * call, which pi's built-in bash tool executes for real: the extension announces the command with
 * `ctx.ui.notify` and delegates the call, and pi draws and streams the row with its built-in bash
 * renderers (merged by tool name, because the extension defines none). The child inherits stdio, so
 * it draws into the caller's terminal (or into the pty created by `script`), and its exit code is
 * forwarded unchanged.
 *
 * Two scenarios exist:
 *
 * - `fixture` (default): one scripted bash call, for the dock's own behaviour.
 * - `subagent`: `subagent-scenario.ts` registers the same faux provider plus an offline probe agent,
 *   and its first scripted turn asks for a bash call and a foreground subagent call at once. pi
 *   runs sibling tool calls concurrently, so the shell dock and pi-subagents' own below-editor
 *   widget are on screen together - the observation this scenario exists for. The pi-subagents
 *   extension is found through `PI_SUBAGENTS_EXTENSION`, the repository's `node_modules`, or the
 *   user package directory.
 *
 * Observation only: nothing here asserts anything, the human watching the screen does.
 *
 * Usage: npm run tui:demo [-- <fixture-id>|subagent]
 *        PI_SHELL_VIEW_COMMAND=... npm run tui:demo
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fixture driven when neither the positional argument nor `PI_SHELL_VIEW_FIXTURE` is given. */
const DEFAULT_FIXTURE_ID = "progress";

/** Scenario id that additionally loads pi-subagents and drives one foreground subagent. */
const SUBAGENT_SCENARIO = "subagent";

/** Observer variables read by the scenario scripts; forwarded to the child process. */
const PI_SHELL_VIEW_VARS = [
    "PI_SHELL_VIEW_SCENARIO",
    "PI_SHELL_VIEW_FIXTURE",
    "PI_SHELL_VIEW_COMMAND",
    "PI_SHELL_VIEW_PROBE_COMMAND",
    "PI_SHELL_VIEW_TIMEOUT",
] as const;

const USAGE = `Usage: npm run tui:demo [-- <fixture-id>|subagent]
       PI_SHELL_VIEW_COMMAND=... npm run tui:demo

Starts the real pi TUI with a scripted faux model and the extension in src/index.ts; the model asks
for real bash tool calls, the extension announces them and delegates to pi's built-in bash tool, and
pi draws the rows with its built-in bash renderers.

  npm run tui:demo                        # default fixture: ${DEFAULT_FIXTURE_ID}
  npm run tui:demo -- failing             # fixture id from test/fixtures/long-running-scripts.ts
  npm run tui:demo -- subagent            # shell dock + pi-subagents widget at the same time
  PI_SHELL_VIEW_COMMAND="ls -la" npm run tui:demo
  PI_SHELL_VIEW_TIMEOUT=5 npm run tui:demo -- flood

The subagent scenario needs pi-subagents: it is looked up at PI_SUBAGENTS_EXTENSION, then
<repo>/node_modules/pi-subagents/index.js, then ~/.pi/agent/npm/node_modules/pi-subagents/index.js.
It runs an offline probe agent (registered by test/tui/subagent-scenario.ts) whose own bash command
is configurable with PI_SHELL_VIEW_PROBE_COMMAND; the parent's bash command stays
PI_SHELL_VIEW_COMMAND.

What to watch for in the fixture scenario: the extension's notification "command: <cmd>", the
"$ <command>" row pi draws, the output streaming in while the fixture runs, how the row settles
(success, truncation warning or the failure text for a failing fixture) and the scripted closing
line "fixture finished".

What to watch for in the subagent scenario: the shell dock line "  Shells · 1 shells · 1 running ·
<command>" below the editor while the subagent runs, pi-subagents' own widget next to it, and both
disappearing as their runs settle ("fixture finished" and "probe finished").

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

/** True when the run should use the subagent scenario. */
function wantsSubagentScenario(argv: string[]): boolean {
    const selection = positional(argv) ?? process.env.PI_SHELL_VIEW_SCENARIO;
    return selection === SUBAGENT_SCENARIO;
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

function main(): void {
    const argv = process.argv.slice(2);
    if (argv[0] === "--help" || argv[0] === "-h") {
        process.stdout.write(USAGE);
        return;
    }

    const subagentScenario = wantsSubagentScenario(argv);
    const extensions = subagentScenario
        ? [repoFile("subagent-scenario.ts"), resolveSubagentExtension(), repoFile("../../src/index.ts")]
        : [repoFile("scripted-provider.ts"), repoFile("../../src/index.ts")];

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
        subagentScenario ? "run the shell-view subagent fixture" : "run the shell-view fixture",
    ];

    const child = spawn("pi", args, {
        stdio: "inherit",
        env: subagentScenario ? childEnv() : { ...childEnv(), PI_SHELL_VIEW_FIXTURE: fixtureId(argv) },
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
