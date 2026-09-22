/**
 * Scripted (faux) provider for the shell dock summary scenario of the real pi TUI observer.
 *
 * Four scripted turns walk the dock through every summary shape the refactored tool can produce -
 * background shells only, because a foreground `bash` call records nothing. Nothing is asserted
 * here - the human watching the TUI judges the lines:
 *
 * 1. one background shell alone: `1 running shell · <command> · <Ns> · /shell to open` while the
 *    long-output fixture streams its 200 lines, then `1 shell completed in <Ns> · /shell to open`.
 *    The fixture is the inspector's scroll demo: its output is longer than the pane, so `/shell` can
 *    be opened mid-stream to watch the pane follow the newest line and to scroll back with
 *    Shift+Up/Shift+K, Shift+Down/Shift+J and Home/End while the run continues;
 * 2. after the first shell settled, a long background `sleep` next to a background `sleep` that its
 *    two-second timeout fails: `3 shells · 2 running · 1 completed · /shell to open`, then
 *    `3 shells · 1 running · 1 completed · 1 failed · /shell to open`;
 * 3. two more background sleeps: `5 shells · 3 running · 1 completed · 1 failed · /shell to open`,
 *    then once they settle `5 shells · 4 completed · 1 failed · /shell to open`.
 *
 * The pauses between the turns are what make the shapes readable: a background call returns
 * immediately, so without them the next turn's shells would land in the same TUI frame and the
 * completed-only and mixed lines would never be drawn. The sequence is fixed on purpose:
 * `PI_SHELL_VIEW_COMMAND`, `PI_SHELL_VIEW_FIXTURE`, `PI_SHELL_VIEW_TIMEOUT` and
 * `PI_SHELL_VIEW_MODE` are ignored here (the launcher passes them only to the fixture scenario).
 */
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getFixture } from "../fixtures/long-running-scripts.ts";

/** Closing text, printed once the last turn's scripted response is consumed. */
const FINAL_TEXT = "dock summary fixture finished";

/** Hint shown when the long-output fixture starts, because its scroll demo needs a manual step. */
const LONG_OUTPUT_HINT = "press /shell to scroll this output (⇧↑/⇧↓, Home/End)";

/** Longest shell of the mixed turns; it keeps one job running while the others settle. */
const LONG_SLEEP_COMMAND = "sleep 5";

/** Shell whose two-second timeout fails it, producing the dock's `failed` count. */
const FAILING_COMMAND = "sleep 10";
const FAILING_TIMEOUT_SECONDS = 2;

/** Two shells that stream nothing and settle quietly, for the final completed-only count. */
const SETTLING_SLEEP_COMMAND = "sleep 4";

/** Long-output runtime is about six seconds; the pause leaves the completed-only line on screen. */
const PAUSE_AFTER_LONG_OUTPUT_MS = 7_500;

/** The failing shell dies two seconds into turn 2; the pause keeps the 3-shell counts readable. */
const PAUSE_BEFORE_SETTLING_TURN_MS = 3_000;

/** The last sleep started at ~10.5s and ends at ~14.5s; the pause lets all shells settle. */
const PAUSE_BEFORE_FINAL_TEXT_MS = 6_000;

/** Sleep helper for the scripted response delays. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI): void {
    const faux = fauxProvider();
    pi.registerProvider(faux.provider);

    const longOutput = getFixture("long-output");

    // The inspector is opened by hand, so the hint has to arrive when the long output really starts.
    pi.on("tool_execution_start", (event, ctx) => {
        if (event.toolName === "bash" && event.args?.command === longOutput.command) {
            ctx.ui.notify(LONG_OUTPUT_HINT, "info");
        }
    });

    // Without a pause the next turn's request would overwrite the completed-only line in the same
    // TUI frame, so the one thing this scenario exists for would never be drawn.
    const mixedTurn: FauxResponseFactory = async () => {
        await sleep(PAUSE_AFTER_LONG_OUTPUT_MS);
        return fauxAssistantMessage(
            [
                fauxToolCall("bash", { command: LONG_SLEEP_COMMAND, mode: "background" }),
                fauxToolCall("bash", { command: FAILING_COMMAND, timeout: FAILING_TIMEOUT_SECONDS, mode: "background" }),
            ],
            { stopReason: "toolUse" },
        );
    };

    const settlingTurn: FauxResponseFactory = async () => {
        await sleep(PAUSE_BEFORE_SETTLING_TURN_MS);
        return fauxAssistantMessage(
            [
                fauxToolCall("bash", { command: SETTLING_SLEEP_COMMAND, mode: "background" }),
                fauxToolCall("bash", { command: SETTLING_SLEEP_COMMAND, mode: "background" }),
            ],
            { stopReason: "toolUse" },
        );
    };

    const finalTurn: FauxResponseFactory = async () => {
        await sleep(PAUSE_BEFORE_FINAL_TEXT_MS);
        return fauxAssistantMessage(FINAL_TEXT);
    };

    faux.setResponses([
        // Turn 1: exactly one shell, so the summary uses its dedicated running/completed format - and
        // its output is long enough to exercise the inspector's scrolling while it streams.
        fauxAssistantMessage(
            fauxToolCall("bash", { command: longOutput.command, mode: "background" }),
            { stopReason: "toolUse" },
        ),
        // Turn 2: a long shell next to one that will fail on its timeout, with the completed long shell
        // keeping the list mixed, so the summary switches to the count list while the failure lands.
        mixedTurn,
        // Turn 3: two more shells, for the running count of a longer mixed list.
        settlingTurn,
        // Waits for the shells to settle, so the last thing on screen is the final count list.
        finalTurn,
    ]);
}
