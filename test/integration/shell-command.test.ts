/**
 * The `/shell` command handler.
 *
 * `/shell` is the only way into the inspector, so the command decides when the overlay opens. With
 * no background jobs it still opens on the empty state - the same frame clearing the last entry
 * leaves on screen - and outside the TUI it must not try to open an overlay at all.
 *
 * The overlay itself is pi's, so the fake UI records the `ctx.ui.custom` factory instead of running
 * it; the tests call that factory with a minimal TUI stub to render the component and assert what
 * the command would show.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { shellManager } from "../../src/shell/shell-manager.ts";
import {
    createFakeContext,
    createTempWorkDir,
    openSession,
    removeTempWorkDir,
    type ExtensionSession,
    type RegisteredCommand,
} from "../harness.ts";

/** Panel width used by every test: wide enough for the empty frame and its message. */
const WIDTH = 110;

describe("/shell command", () => {
    let workDir: string;
    let session: ExtensionSession;
    let shellCommand: RegisteredCommand;

    beforeEach(async () => {
        shellManager.clearAllJobs();
        workDir = createTempWorkDir("shell-command");
        session = await openSession(workDir);

        const command = session.host.registeredCommands.find((entry) => entry.name === "shell");
        assert.ok(command, "the extension must register the /shell command");
        shellCommand = command;
    });

    afterEach(async () => {
        // Teardown clears the manager and drops the dock listener, so a failed assertion cannot leak
        // a job or a listener into the next test.
        await session.host.emit("session_shutdown", session.ctx);
        removeTempWorkDir(workDir);
    });

    /**
     * Build the overlay component the command's last `custom` call would show.
     *
     * `openShellInspector` only reads `requestRender` and `terminal.rows` off the TUI and takes its
     * theme from the extension context, so this minimal stub renders a real frame.
     */
    function buildOverlay(): { render(width: number): string[]; dispose(): void } {
        const call = session.ui.customCalls.at(-1);
        assert.ok(call, "the command must ask pi for a custom overlay");

        return call.factory(
            { requestRender: () => { }, terminal: { rows: 40 } },
            session.ctx.ui.theme,
            undefined,
            () => { },
        ) as { render(width: number): string[]; dispose(): void };
    }

    it("opens the empty inspector when there are no jobs", async () => {
        await shellCommand.handler("", session.ctx);

        assert.equal(session.ui.customCalls.length, 1, "the command must open exactly one overlay");

        const overlay = buildOverlay();

        try {
            const lines = overlay.render(WIDTH);

            assert.ok(lines.length > 0, `the empty inspector must still draw a frame, got ${lines.length} lines`);
            assert.ok(lines[0]!.includes("┌"), `expected a top border: ${JSON.stringify(lines)}`);
            assert.ok(lines.at(-1)!.includes("└"), `expected a bottom border: ${JSON.stringify(lines)}`);
            assert.ok(
                lines.some((line) => line.includes("No background shell running")),
                `the empty pane must say why it is empty: ${JSON.stringify(lines)}`,
            );
        } finally {
            overlay.dispose();
        }
    });

    it("does not open the inspector outside the TUI", async () => {
        const printContext = createFakeContext(workDir, { ui: session.ui, mode: "print" });

        await shellCommand.handler("", printContext);

        assert.equal(session.ui.customCalls.length, 0, "a non-TUI session must not open an overlay");
    });
});
