/**
 * Scripted (faux) provider for the shell dock summary scenario of the real pi TUI observer.
 *
 * Three scripted turns walk the dock through every summary shape the extension can render. Nothing
 * is asserted here - the human watching the TUI judges the lines:
 *
 * 1. one shell alone: `1 running shell · <command> · <Ns> · /shell to open` while the long-output
 *    fixture streams its 200 lines, then `1 shell completed in <Ns> · /shell to open`. The fixture is
 *    the inspector's scroll demo: its output is longer than the pane, so `/shell` can be opened mid-
 *    stream to watch the pane follow the newest line and to scroll back with Shift+Up/Shift+K,
 *    Shift+Down/Shift+J and Home/End while the run continues;
 * 2. a long `sleep` next to the failing fixture, with the completed long-output shell still in the
 *    list: `3 shells · 2 running · 1 completed · /shell to open`, then once the failure landed
 *    `3 shells · 1 running · 1 completed · 1 failed · /shell to open`;
 * 3. two long `sleep` siblings: `5 shells · 2 running · 2 completed · 1 failed · /shell to open`, then
 *    the settled counts; pressing Esc while they run aborts them, which the summary reports as
 *    stopped shells.
 *
 * The sequence is fixed on purpose: `PI_SHELL_VIEW_COMMAND`, `PI_SHELL_VIEW_FIXTURE` and
 * `PI_SHELL_VIEW_TIMEOUT` are ignored here (the launcher passes them only to the fixture scenario).
 */
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getFixture } from "../fixtures/long-running-scripts.ts";

/** Closing text, printed once the last turn's tool calls settled. */
const FINAL_TEXT = "dock summary fixture finished";

/** Hint shown when the long-output fixture starts, because its scroll demo needs a manual step. */
const LONG_OUTPUT_HINT = "press /shell to scroll this output (⇧↑/⇧↓, Home/End)";

/** Keeps the last two shells running long enough to read the line and to abort them with Esc. */
const LONG_SLEEP_COMMAND = "sleep 8";

/** Lets the completed-only summary stay on screen before the mixed turn replaces it. */
const PAUSE_BEFORE_MIXED_TURN_MS = 800;

export default function (pi: ExtensionAPI): void {
    const faux = fauxProvider();
    pi.registerProvider(faux.provider);

    const longOutput = getFixture("long-output");
    const failingCommand = getFixture("failing").command;

    // The inspector is opened by hand, so the hint has to arrive when the long output really starts.
    pi.on("tool_execution_start", (event, ctx) => {
        if (event.toolName === "bash" && event.args?.command === longOutput.command) {
            ctx.ui.notify(LONG_OUTPUT_HINT, "info");
        }
    });

    // Without the pause, the next turn's request would overwrite the completed-only line in the same
    // TUI frame, so the one thing this scenario exists for would never be drawn.
    const mixedTurn: FauxResponseFactory = async () => {
        await new Promise((resolve) => setTimeout(resolve, PAUSE_BEFORE_MIXED_TURN_MS));
        return fauxAssistantMessage(
            [
                fauxToolCall("bash", { command: "sleep 6" }),
                fauxToolCall("bash", { command: failingCommand }),
            ],
            { stopReason: "toolUse" },
        );
    };

    faux.setResponses([
        // Turn 1: exactly one shell, so the summary uses its dedicated running/completed format - and
        // its output is long enough to exercise the inspector's scrolling while it streams.
        fauxAssistantMessage(
            fauxToolCall("bash", { command: longOutput.command }),
            { stopReason: "toolUse" },
        ),
        // Turn 2: a long shell next to a failing one; the completed long shell keeps the list mixed,
        // so the summary switches to the count list while the failure lands.
        mixedTurn,
        // Turn 3: two long shells at once; aborting them adds stopped shells to the counts.
        fauxAssistantMessage(
            [
                fauxToolCall("bash", { command: LONG_SLEEP_COMMAND }),
                fauxToolCall("bash", { command: LONG_SLEEP_COMMAND }),
            ],
            { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(FINAL_TEXT),
    ]);
}
