/**
 * Scripted (faux) provider that drives the real pi TUI observer.
 *
 * Loaded by pi as an extension (`pi -e test/tui/scripted-provider.ts -e src/index.ts`), it registers
 * pi-ai's official `fauxProvider()` and queues exactly two responses: one `bash` tool call that runs
 * a long-running fixture script, and one line of closing text. Nothing is mocked below the model:
 * the call travels through pi's real agent loop, the built-in bash tool really executes the script,
 * and the `bash` tool re-registered by `src/index.ts` announces the command and delegates the call,
 * so pi keeps drawing and streaming the row with its built-in bash renderers.
 *
 * Selection (all optional, no silent fallback):
 * - `PI_SHELL_VIEW_COMMAND` replaces the command outright, for ad-hoc observation of any long task.
 * - `PI_SHELL_VIEW_FIXTURE` picks a fixture from `test/fixtures/long-running-scripts.ts` by id
 *   (default `progress`); an unknown id throws while this extension loads.
 * - `PI_SHELL_VIEW_TIMEOUT` is forwarded to the bash tool as its timeout in seconds.
 */
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getFixture } from "../fixtures/long-running-scripts.ts";

/** Fixture driven when `PI_SHELL_VIEW_FIXTURE` is unset. */
const DEFAULT_FIXTURE_ID = "progress";

/** Single line the scripted model answers after the tool result; the queue ends here. */
const FINAL_TEXT = "fixture finished";

/** Command of the scripted bash call: an explicit override wins, otherwise the fixture's command. */
function scriptedCommand(): string {
    const override = process.env.PI_SHELL_VIEW_COMMAND;
    if (override !== undefined) {
        return override;
    }
    const fixtureId = process.env.PI_SHELL_VIEW_FIXTURE ?? DEFAULT_FIXTURE_ID;
    // getFixture throws on unknown ids, so a typo surfaces while the extension loads instead of
    // quietly running a different fixture.
    return getFixture(fixtureId).command;
}

/** Timeout in seconds for the scripted bash call, or undefined when `PI_SHELL_VIEW_TIMEOUT` is unset. */
function scriptedTimeoutSeconds(): number | undefined {
    const raw = process.env.PI_SHELL_VIEW_TIMEOUT;
    if (raw === undefined) {
        return undefined;
    }
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`PI_SHELL_VIEW_TIMEOUT must be a positive number of seconds, got ${JSON.stringify(raw)}`);
    }
    return seconds;
}

export default function (pi: ExtensionAPI): void {
    const faux = fauxProvider();
    pi.registerProvider(faux.provider);

    const toolArguments: { command: string; timeout?: number } = { command: scriptedCommand() };
    const timeout = scriptedTimeoutSeconds();
    if (timeout !== undefined) {
        toolArguments.timeout = timeout;
    }

    faux.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", toolArguments), { stopReason: "toolUse" }),
        fauxAssistantMessage(FINAL_TEXT),
    ]);
}
