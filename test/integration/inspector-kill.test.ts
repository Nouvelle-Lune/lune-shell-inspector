/**
 * Killing a shell from the inspector's kill key.
 *
 * `/shell` is the human's only handle on a detached shell, so pressing `x` has to reach the real
 * process and not just repaint the pane: the key settles the selected job through the shell manager
 * as killed, with the reason the pane shows, and that kill aborts the job's controller - the abort
 * pi's local bash operations turn into a SIGKILL of the child's process group. A kill is also a
 * terminal job event like any other, so the session tells the agent exactly once: the user's
 * decision, the reason and the output collected so far arrive as a steering message, and a shell
 * the human stopped can no longer be mistaken for one that is still running.
 *
 * The tests drive a real background command through the registered tool and press the key through
 * the same render-then-input order the TUI uses. Which shell the key selects, and how the pane
 * reads afterwards, is unit-tested in `test/unit/shell-inspector.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import { ShellInspector } from "../../src/shell/shell-inspector.ts";
import { shellManager } from "../../src/shell/shell-manager.ts";
import {
    createTempWorkDir,
    openSession,
    removeTempWorkDir,
    startBackgroundBashCommand,
    waitFor,
    type ExtensionSession,
    type SendMessageCall,
} from "../harness.ts";

/** Panel width used by every test: wide enough for the right pane to keep long lines untruncated. */
const WIDTH = 110;

/** Rows of a terminal tall enough for the body to hit its maximum height. */
const TERMINAL_ROWS = 40;

/** Theme stub: colours become plain text, so a test failure prints the pane as it reads on screen. */
const stubTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

/** Text of one captured `pi.sendMessage` call. */
function messageText(call: SendMessageCall): string {
    return typeof call.message.content === "string" ? call.message.content : "";
}

/**
 * Node's liveness probe.
 *
 * `kill(pid, 0)` sends no signal and only reports whether the pid can still be signalled, which is
 * what makes it usable as "is the shell still there" after a kill.
 */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the process exists but belongs to somebody else; ESRCH means it is gone.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

describe("lune-shell-inspector kill key", () => {
    let workDir: string;
    let session: ExtensionSession;
    let inspector: ShellInspector;
    let pidFile: string;

    beforeEach(async () => {
        shellManager.clearAllJobs();
        workDir = createTempWorkDir("inspector-kill");
        session = await openSession(workDir);
        pidFile = join(workDir, "shell.pid");

        inspector = new ShellInspector(
            session.ctx,
            () => { },
            () => { },
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

    /** The pid the background shell published, once the file is readable. */
    async function waitForPid(): Promise<number> {
        await waitFor("the background shell to publish its pid", () => {
            try {
                return Number(readFileSync(pidFile, "utf8").trim()) > 0;
            } catch {
                return false;
            }
        });

        return Number(readFileSync(pidFile, "utf8").trim());
    }

    it("kills the selected shell's process and reports the kill to the agent", async () => {
        // The command publishes its own pid, prints a ready line and then holds: the pid is what
        // proves the kill reached the process tree, and the ready line is what the agent must still
        // receive, because the notification is its only view of the shell the human stopped.
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: `echo $$ > '${pidFile}'; printf 'ready\\n'; exec sleep 300`,
            ctx: session.ctx,
            toolCallId: "call-inspector-kill",
        });

        const pid = await waitForPid();
        await waitFor("the shell's ready line to reach the job", () =>
            (shellManager.getJob(jobId)?.output.content ?? "").includes("ready"));
        assert.equal(isProcessAlive(pid), true, "the shell must be running before the kill");

        press("x");

        const killed = shellManager.getJob(jobId);
        assert.ok(killed, "the killed shell must stay listed");
        assert.equal(killed.status, "killed");
        assert.equal(killed.error, "Shell killed by user");
        assert.equal(killed.controller.signal.aborted, true);
        assert.deepEqual(
            shellManager.getAllJobsStatusStat(),
            { runningCount: 0, completedCount: 0, failedCount: 0, killedCount: 1 },
        );

        await waitFor("the killed shell's process to exit", () => !isProcessAlive(pid));

        assert.equal(session.host.sendMessageCalls.length, 1, "a kill must notify the agent exactly once");
        const notification = session.host.sendMessageCalls[0]!;

        assert.equal(notification.message.customType, "background-shell-notification");
        assert.equal(notification.message.display, false, "the notification must not enter the transcript");
        assert.equal(notification.options?.deliverAs, "steer");
        assert.deepEqual(notification.message.details, {
            shellJobId: jobId,
            status: "killed",
            exitCode: undefined,
        });

        const text = messageText(notification);
        assert.ok(text.startsWith(`Background shell ${jobId} killed.`), text);
        assert.ok(text.includes("Error: Shell killed by user"), text);
        assert.ok(text.includes("Output:\nready"), `the output collected before the kill must reach the agent: ${text}`);
    });

    it("kills only the shell the user selected", async () => {
        const other = await startBackgroundBashCommand(session.tool, {
            command: "exec sleep 300",
            ctx: session.ctx,
            toolCallId: "call-other-shell",
        });
        const target = await startBackgroundBashCommand(session.tool, {
            command: "exec sleep 300",
            ctx: session.ctx,
            toolCallId: "call-selected-shell",
        });

        // The selection starts on the oldest shell, so the second one has to be reached with `j`.
        press("j");
        press("x");

        assert.equal(shellManager.getJob(target.jobId)?.status, "killed");
        assert.equal(shellManager.getJob(other.jobId)?.status, "running", "the unselected shell must survive");
        assert.equal(shellManager.getJob(other.jobId)?.controller.signal.aborted, false);
        assert.deepEqual(
            shellManager.getAllJobsStatusStat(),
            { runningCount: 1, completedCount: 0, failedCount: 0, killedCount: 1 },
        );
    });
});
