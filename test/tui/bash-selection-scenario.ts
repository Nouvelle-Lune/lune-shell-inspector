/**
 * Scripted (faux) provider for the bash-selection scenario of the real pi TUI observer.
 *
 * The point is the wrapper's two execution modes chosen the way a model should choose them, in one
 * session:
 *
 * 1. a quick command whose result the turn needs to continue: `mode` is omitted (foreground), so
 *    the call is delegated to pi's built-in bash tool - the row streams and settles like a plain
 *    bash call, and no shell job appears anywhere;
 * 2. a long-running command that may continue independently: `mode: "background"`, so the call
 *    leaves no transcript row and the shell dock plus the `/shell` inspector show the job while it
 *    streams;
 * 3. the closing text arrives after the background shell settled, so the inspector can also be
 *    inspected in its settled state.
 *
 * Nothing is asserted here - the human watching the TUI judges the rows, the dock and the inspector.
 *
 * Selection (all optional, no silent fallback):
 * - `LUNE_SHELL_INSPECTOR_COMMAND` replaces the long background command.
 * - `LUNE_SHELL_INSPECTOR_FIXTURE` picks the long background fixture (default `long-output`, whose 200
 *   lines overflow the inspector's pane); an unknown id throws while this extension loads.
 * - `LUNE_SHELL_INSPECTOR_TIMEOUT` is the background command's timeout in seconds.
 * The quick foreground command is fixed on purpose: it exists to show the delegation path.
 */
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
    type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getFixture } from "../fixtures/long-running-scripts.ts";

/** Synthetic low-risk command whose result the scripted turn pretends to need before continuing. */
const QUICK_COMMAND = "printf 'workspace: 2 changed files\\n'";

/** Fixture behind the background call when `LUNE_SHELL_INSPECTOR_FIXTURE` is unset. */
const DEFAULT_BACKGROUND_FIXTURE = "long-output";

/** Text the scripted model prints when it picks each mode; the TUI shows them next to the tool rows. */
const FOREGROUND_REASON = "Quick probe: I need this result before continuing, so foreground.";
const BACKGROUND_REASON =
    "The long export can continue on its own - background it, then inspect it with /shell.";

/** Closing text, printed once the background shell settled. */
const FINAL_TEXT = "bash selection fixture finished";

/** Lets the foreground row settle on screen before the background turn starts. */
const PAUSE_BEFORE_BACKGROUND_MS = 700;

/** Long-output runs about six seconds; the pause keeps the settled job in the inspector afterwards. */
const PAUSE_BEFORE_FINAL_TEXT_MS = 7_500;

/** Sleep helper for the scripted response delays. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Long background command: the explicit override wins, otherwise the selected fixture. */
function backgroundCommand(): string {
    const override = process.env.LUNE_SHELL_INSPECTOR_COMMAND;
    if (override !== undefined) {
        return override;
    }
    const fixtureId = process.env.LUNE_SHELL_INSPECTOR_FIXTURE ?? DEFAULT_BACKGROUND_FIXTURE;
    // getFixture throws on unknown ids, so a typo surfaces while the extension loads instead of
    // quietly running a different fixture.
    return getFixture(fixtureId).command;
}

/** Timeout in seconds for the background command, or undefined when `LUNE_SHELL_INSPECTOR_TIMEOUT` is unset. */
function backgroundTimeoutSeconds(): number | undefined {
    const raw = process.env.LUNE_SHELL_INSPECTOR_TIMEOUT;
    if (raw === undefined) {
        return undefined;
    }
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`LUNE_SHELL_INSPECTOR_TIMEOUT must be a positive number of seconds, got ${JSON.stringify(raw)}`);
    }
    return seconds;
}

export default function (pi: ExtensionAPI): void {
    const faux = fauxProvider();
    pi.registerProvider(faux.provider);

    const longCommand = backgroundCommand();
    const backgroundArguments: { command: string; mode: "background"; timeout?: number } = {
        command: longCommand,
        mode: "background",
    };
    const timeout = backgroundTimeoutSeconds();
    if (timeout !== undefined) {
        backgroundArguments.timeout = timeout;
    }

    const backgroundTurn: FauxResponseFactory = async () => {
        await sleep(PAUSE_BEFORE_BACKGROUND_MS);
        return fauxAssistantMessage(
            [fauxText(BACKGROUND_REASON), fauxToolCall("bash", backgroundArguments)],
            { stopReason: "toolUse" },
        );
    };

    const finalTurn: FauxResponseFactory = async () => {
        await sleep(PAUSE_BEFORE_FINAL_TEXT_MS);
        return fauxAssistantMessage(FINAL_TEXT);
    };

    faux.setResponses([
        // Turn 1: result needed now, so the mode stays unset and the built-in delegation runs.
        fauxAssistantMessage(
            [fauxText(FOREGROUND_REASON), fauxToolCall("bash", { command: QUICK_COMMAND })],
            { stopReason: "toolUse" },
        ),
        // Turn 2: independent long task -> managed shell job.
        backgroundTurn,
        // Waits for the job to settle, so the inspector can also be opened on the settled shell.
        finalTurn,
    ]);
}
