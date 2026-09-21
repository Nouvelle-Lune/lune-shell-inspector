/**
 * Registry of the long-running fixtures shared by the tests.
 *
 * Every entry points at a real script under `test/fixtures/scripts` that keeps running for 2-4
 * seconds and streams output while it runs, so the built-in bash tool's throttled `onUpdate`
 * callbacks - and, in the real TUI observer under `test/tui`, pi's rendering of them - can be
 * exercised end to end. Scripts are always invoked through an absolute path (`bash <path>` /
 * `node <path>`): no chmod, no network, no python.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "scripts");

/** What one fixture run must prove; consumed by the tests. */
export interface FixtureExpectations {
    /** The built-in bash tool is expected to throw, so the request renders as a failure. */
    fails: boolean;
    /** Exit code carried by the built-in "Command exited with code N" message (failing fixture only). */
    exitCode?: number;
    /** Output is expected to exceed the built-in truncation limits (2000 lines / 50KB). */
    truncated: boolean;
    /** Substrings the final output body must contain (successful fixtures only). */
    outputIncludes: string[];
    /** Substrings the thrown error message must contain (failing fixture only). */
    errorIncludes: string[];
    /** Substrings the persisted full-output file must contain once truncation kicked in. */
    fullOutputIncludes: string[];
    /** Lower bound for the output line count the settled call reports. */
    minLines: number;
    /** Lower bound for the wall-clock duration, proving the fixture really streams over time. */
    minDurationMs: number;
    /** Upper bound for the wall-clock duration, keeping the suite fast. */
    maxDurationMs: number;
}

/** One long-running fixture script together with the command that runs it. */
export interface LongRunningFixture {
    id: string;
    title: string;
    /** Absolute path of the script; independent of the repository root. */
    scriptPath: string;
    /** Command handed to the bash tool (interpreter plus absolute script path). */
    command: string;
    expectations: FixtureExpectations;
}

/** Absolute path of a script shipped with the fixtures. */
function scriptPath(file: string): string {
    return join(SCRIPT_DIR, file);
}

/** Interpreter invocation for a script, chosen by extension. */
function scriptCommand(file: string): string {
    const path = scriptPath(file);
    return `${path.endsWith(".mjs") ? "node" : "bash"} ${path}`;
}

/** Every fixture, in the order the tests run them. */
export const LONG_RUNNING_FIXTURES: LongRunningFixture[] = [
    {
        id: "progress",
        title: "Single-line percentage progress refreshed with carriage returns",
        scriptPath: scriptPath("progress.sh"),
        command: scriptCommand("progress.sh"),
        expectations: {
            fails: false,
            truncated: false,
            outputIncludes: ["progress: 100%", "progress: done"],
            errorIncludes: [],
            fullOutputIncludes: [],
            minLines: 2,
            minDurationMs: 1500,
            maxDurationMs: 10000,
        },
    },
    {
        id: "log-stream",
        title: "Twenty timestamped log lines, one every 100ms",
        scriptPath: scriptPath("log-stream.sh"),
        command: scriptCommand("log-stream.sh"),
        expectations: {
            fails: false,
            truncated: false,
            outputIncludes: ["[log]", "line 20 of 20"],
            errorIncludes: [],
            fullOutputIncludes: [],
            minLines: 15,
            minDurationMs: 1500,
            maxDurationMs: 10000,
        },
    },
    {
        id: "flood",
        title: "Paced flood of 5000 lines / ~200KB that trips the built-in truncation",
        scriptPath: scriptPath("flood.mjs"),
        command: scriptCommand("flood.mjs"),
        expectations: {
            fails: false,
            truncated: true,
            outputIncludes: ["flood line", "Full output:"],
            errorIncludes: [],
            fullOutputIncludes: ["flood line 05000"],
            minLines: 500,
            minDurationMs: 1500,
            maxDurationMs: 10000,
        },
    },
    {
        id: "failing",
        title: "Stdout lines followed by stderr lines and exit code 3",
        scriptPath: scriptPath("failing.sh"),
        command: scriptCommand("failing.sh"),
        expectations: {
            fails: true,
            exitCode: 3,
            truncated: false,
            outputIncludes: [],
            errorIncludes: ["build: step 1 ok", "fatal: aborting with code 3", "Command exited with code 3"],
            fullOutputIncludes: [],
            minLines: 4,
            minDurationMs: 1500,
            maxDurationMs: 10000,
        },
    },
];

/** Look up one fixture by id; throws when the id is unknown. */
export function getFixture(id: string): LongRunningFixture {
    const fixture = LONG_RUNNING_FIXTURES.find((entry) => entry.id === id);
    if (!fixture) {
        throw new Error(`Unknown fixture id ${JSON.stringify(id)}; available: ${fixtureIds().join(", ")}`);
    }
    return fixture;
}

/** All fixture ids, used for CLI validation and error messages. */
export function fixtureIds(): string[] {
    return LONG_RUNNING_FIXTURES.map((fixture) => fixture.id);
}
