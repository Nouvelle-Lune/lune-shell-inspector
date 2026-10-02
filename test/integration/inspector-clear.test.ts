/**
 * Clearing a shell from the inspector's clear key.
 *
 * `/shell` accumulates one entry per background shell for the life of the session, so `c` is the way
 * to take a finished one out of the list. The key only clears a settled shell (`completed`, `failed`
 * or `killed`): a running shell is refused with the notice the footer shows, and the refusal must
 * leave the live process and its notification path alone. A cleared shell is gone from the manager,
 * so the dock re-renders without it and no second notification reaches the agent.
 *
 * The tests drive real background commands through the registered tool and press the key through the
 * same render-then-input order the TUI uses. Selection and notice behaviour is unit-tested in
 * `test/unit/shell-inspector.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { ShellInspector } from "../../src/shell/shell-inspector.ts";
import { shellManager } from "../../src/shell/shell-manager.ts";
import {
    createTempWorkDir,
    openSession,
    removeTempWorkDir,
    startBackgroundBashCommand,
    waitForJobSettled,
    type ExtensionSession,
} from "../harness.ts";

/** Panel width used by every test: wide enough for the right pane to keep long lines untruncated. */
const WIDTH = 110;

/** Rows of a terminal tall enough for the body to hit its maximum height. */
const TERMINAL_ROWS = 40;

/** Widget key the shell dock uses. */
const WIDGET_ID = "lune-shell-inspector";

/** Theme stub: colours become plain text, so a test failure prints the pane as it reads on screen. */
const stubTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

const ZERO_STATS = {
    runningCount: 0,
    completedCount: 0,
    failedCount: 0,
    killedCount: 0,
};

describe("lune-shell-inspector clear key", () => {
    let workDir: string;
    let session: ExtensionSession;
    let inspector: ShellInspector;
    let closeRequests: number;

    beforeEach(async () => {
        shellManager.clearAllJobs();
        workDir = createTempWorkDir("inspector-clear");
        session = await openSession(workDir);
        closeRequests = 0;

        inspector = new ShellInspector(
            session.ctx,
            () => { },
            () => {
                closeRequests += 1;
            },
            () => TERMINAL_ROWS,
            stubTheme,
        );
    });

    afterEach(async () => {
        inspector.dispose();
        // Teardown kills whatever the test left running, so a failed assertion cannot leak a shell.
        await session.host.emit("session_shutdown", session.ctx);
        removeTempWorkDir(workDir);
    });

    /** Draw one frame and route one key, in the order the TUI uses (render first, then input). */
    function press(data: string): void {
        inspector.render(WIDTH);
        inspector.handleInput(data);
    }

    /** The footer row of one rendered frame: the key hints, or the notice that replaced them. */
    function footerLine(): string {
        return inspector.render(WIDTH).at(-2) ?? "";
    }

    /** The mounted dock line, or undefined when the dock is not mounted. */
    function dockText(): string | undefined {
        const content = session.ui.mountedWidget("belowEditor", WIDGET_ID);

        if (content === undefined) {
            return undefined;
        }

        assert.ok(Array.isArray(content), "the dock must be mounted as an array of lines");

        return content.join("\n");
    }

    it("clears a completed shell and leaves no dock behind", async () => {
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "printf 'done\\n'",
            ctx: session.ctx,
            toolCallId: "call-clear-completed",
        });
        assert.equal((await waitForJobSettled(jobId)).status, "completed", "the shell must settle before it can be cleared");

        const controller = shellManager.getJob(jobId)!.controller;
        assert.equal(session.host.sendMessageCalls.length, 1, "the settle must notify the agent once");
        assert.match(dockText() ?? "", /1 shell completed/, "the settled shell must appear as completed in the dock");

        press("c");

        assert.equal(shellManager.getJob(jobId)?.id, undefined, "the cleared shell must be gone from the manager");
        assert.deepEqual(shellManager.getAllJobsStatusStat(), ZERO_STATS, "clearing the last shell must empty the counters");
        assert.equal(controller.signal.aborted, false, "clearing a settled shell must not abort anything");
        assert.equal(dockText(), undefined, "the dock must disappear with the last shell");
        assert.equal(session.host.sendMessageCalls.length, 1, "clearing must not notify the agent");
        assert.ok(footerLine().includes("Cleared printf 'done\\n'"), `the footer must confirm the clear: ${footerLine()}`);
    });

    it("refuses a running shell and says why", async () => {
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "exec sleep 300",
            ctx: session.ctx,
            toolCallId: "call-clear-running",
        });
        const controller = shellManager.getJob(jobId)!.controller;

        press("c");

        const job = shellManager.getJob(jobId);
        assert.ok(job, "the running shell must stay in the manager");
        assert.equal(job.status, "running", "a running shell must keep its status");
        assert.equal(controller.signal.aborted, false, "the refusal must not abort the process");
        assert.deepEqual(shellManager.getAllJobsStatusStat(), {
            runningCount: 1,
            completedCount: 0,
            failedCount: 0,
            killedCount: 0,
        }, "a refusal must not move a counter");
        assert.match(dockText() ?? "", /1 running shell/, "the dock must keep the running shell");
        assert.equal(closeRequests, 0, "a refusal must not close the inspector");

        const refusal = "Clear failed, only completed, failed, or killed";
        assert.ok(footerLine().includes(refusal), `the footer must explain the refusal: ${footerLine()}`);
    });

    it("clears a shell the user killed, without a second notification", async () => {
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "exec sleep 300",
            ctx: session.ctx,
            toolCallId: "call-clear-killed",
        });

        press("x");
        assert.equal(shellManager.getJob(jobId)?.status, "killed", "the kill key must settle the shell as killed");
        assert.equal(session.host.sendMessageCalls.length, 1, "the kill must notify the agent once");

        press("c");

        assert.equal(shellManager.getJob(jobId)?.id, undefined, "the killed shell must be clearable");
        assert.deepEqual(shellManager.getAllJobsStatusStat(), ZERO_STATS, "clearing the killed shell must empty the counters");
        assert.equal(session.host.sendMessageCalls.length, 1, "clearing a killed shell must not notify again");
    });

    it("clears each settled shell in turn and keeps the others in the dock", async () => {
        const completed = await startBackgroundBashCommand(session.tool, {
            command: "printf 'done\\n'",
            ctx: session.ctx,
            toolCallId: "call-clear-mixed-completed",
        });
        const failed = await startBackgroundBashCommand(session.tool, {
            command: "printf 'bad\\n'; exit 3",
            ctx: session.ctx,
            toolCallId: "call-clear-mixed-failed",
        });
        assert.equal((await waitForJobSettled(completed.jobId)).status, "completed", "the first shell must settle as completed");
        assert.equal((await waitForJobSettled(failed.jobId)).status, "failed", "the second shell must settle as failed");
        assert.match(dockText() ?? "", /2 shells · 1 completed · 1 failed/, "both settled shells must appear in the dock");

        press("c"); // the selection starts on the completed shell

        assert.equal(shellManager.getJob(completed.jobId)?.id, undefined, "the selected completed shell must be cleared");
        assert.equal(shellManager.getJob(failed.jobId)?.status, "failed", "the other settled shell must survive");
        assert.deepEqual(shellManager.getAllJobsStatusStat(), {
            runningCount: 0,
            completedCount: 0,
            failedCount: 1,
            killedCount: 0,
        }, "only the cleared shell's counter may drop");
        assert.match(dockText() ?? "", /1 shell · 1 failed/, "the dock must keep the surviving shell");

        press("c"); // the selection clamps to the shell that is left

        assert.equal(shellManager.getJob(failed.jobId)?.id, undefined, "the remaining shell must be cleared next");
        assert.deepEqual(shellManager.getAllJobsStatusStat(), ZERO_STATS, "clearing every shell must empty the counters");
        assert.equal(dockText(), undefined, "the dock must disappear with the last shell");
    });
});
