/**
 * Session lifecycle contract of pi-shell-view.
 *
 * The extension keeps the shared `ShellManager` in sync with the session: `session_start` empties
 * the job list (aborting any shell the previous session left running), renders the dock and
 * subscribes it to every later job mutation; `session_shutdown` unsubscribes, clears the dock and
 * drops the jobs. Around that, only background tool calls (`mode: "background"`) create jobs: the
 * dock appears while the command runs, follows the streamed output and keeps the settled job
 * afterwards. Foreground calls record nothing, which is asserted in
 * `test/integration/bash-delegation.test.ts`.
 *
 * These tests drive one fake session at a time and assert both halves: the jobs the manager holds
 * and the widget calls the session's UI received.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { shellManager } from "../../src/shell/shell-manager.ts";
import {
    createTempWorkDir,
    openSession,
    removeTempWorkDir,
    startBackgroundBashCommand,
    waitForJobSettled,
    type ExtensionSession,
    type FakeExtensionUi,
} from "../harness.ts";

/** Widget key the shell dock uses. */
const WIDGET_ID = "pi-shell-view";

/** Run a session and always shut it down again, even when the test fails. */
async function withSession(
    label: string,
    body: (session: ExtensionSession) => Promise<void>,
): Promise<void> {
    const workDir = createTempWorkDir(label);
    const session = await openSession(workDir);
    try {
        await body(session);
    } finally {
        await session.host.emit("session_shutdown", session.ctx);
        removeTempWorkDir(workDir);
    }
}

/** The dock line mounted below the editor, or undefined when no widget is mounted. */
function dockLine(ui: FakeExtensionUi): readonly string[] | undefined {
    const content = ui.mountedWidget("belowEditor", WIDGET_ID);
    if (content === undefined) {
        return undefined;
    }
    assert.ok(Array.isArray(content), "the dock must be mounted as an array of lines");
    return content;
}

/**
 * Text of the single dock line mounted below the editor, or undefined when none is mounted.
 *
 * The summary embeds wall-clock elapsed seconds, so tests match the line as a pattern instead of
 * pinning a value that depends on how fast the command ran.
 */
function dockText(ui: FakeExtensionUi): string | undefined {
    const content = dockLine(ui);
    assert.ok(content === undefined || content.length === 1, "the dock must stay a single line");
    return content?.[0];
}

/** Widget calls that mounted or cleared the shell dock. */
function dockCalls(ui: FakeExtensionUi): number {
    return ui.widgetCalls.filter((call) => call.key === WIDGET_ID).length;
}

/** Start a job directly in the manager, the way the background runner does. */
function startJob(id: string, command: string, cwd: string): AbortController {
    const controller = new AbortController();
    shellManager.startJob({ id, command, cwd, controller });
    return controller;
}

describe("pi-shell-view session lifecycle", () => {
    beforeEach(() => {
        shellManager.clearAllJobs();
    });

    afterEach(() => {
        shellManager.clearAllJobs();
    });

    describe("session_start", () => {
        it("starts with an empty job list and no mounted dock", async () => {
            // Contract: module state survives extension reloads, so a new session clears whatever the
            // previous one left behind and mounts nothing while there is no job.
            const stale = startJob("stale", "sleep 999", "/tmp");

            await withSession("start-empty", async (session) => {
                assert.deepEqual(shellManager.getAllJobsList(), [], "starting a session must drop stale jobs");
                assert.equal(stale.signal.aborted, true, "starting a session must stop leftover processes");
                assert.equal(dockLine(session.ui), undefined);
                assert.deepEqual(session.ui.widgetCalls.at(-1)?.content, undefined, "the dock must be cleared");
            });
        });

        it("renders the dock on every later job mutation", async () => {
            // Contract: the subscription installed by session_start is what makes the dock follow the
            // manager; without it a job change would never reach pi.
            await withSession("start-subscribe", async (session) => {
                assert.equal(dockCalls(session.ui), 1, "session_start renders once");

                startJob("job-1", "sleep 30", "/tmp");
                assert.match(dockText(session.ui) ?? "", /^1 running shell · sleep 30 · \d+s · \/shell to open$/);

                shellManager.appendOutput("job-1", "chunk\n");
                assert.match(dockText(session.ui) ?? "", /^1 running shell · sleep 30 · \d+s · \/shell to open$/);

                shellManager.settleJob("job-1", { type: "completed", exitCode: 3 });
                assert.match(dockText(session.ui) ?? "", /^1 shell completed in \d+s · \/shell to open$/);

                startJob("job-2", "sleep 60", "/tmp");
                shellManager.settleJob("job-2", { type: "killed", error: "timeout:1" });
                assert.equal(dockText(session.ui), "2 shells · 1 completed · 1 killed · /shell to open");

                assert.equal(dockCalls(session.ui), 6, "expected one render per mutation and for session_start");
            });
        });

        it("hands the dock over from an ended session to the next one", async () => {
            // Contract: an ended session has unsubscribed in session_shutdown, so its context is never
            // rendered again; a session started afterwards is the only one following the manager.
            const firstDir = createTempWorkDir("handover-first");
            const secondDir = createTempWorkDir("handover-second");
            const first = await openSession(firstDir);
            await first.host.emit("session_shutdown", first.ctx);
            const firstCallsAfterShutdown = dockCalls(first.ui);

            const second = await openSession(secondDir);
            try {
                const secondCallsAfterStart = dockCalls(second.ui);

                startJob("job-1", "sleep 30", "/tmp");

                assert.equal(dockCalls(first.ui), firstCallsAfterShutdown, "the ended session must not render again");
                assert.equal(dockCalls(second.ui), secondCallsAfterStart + 1, "the new session must render");
                assert.match(dockText(second.ui) ?? "", /^1 running shell · sleep 30 · \d+s · \/shell to open$/);
            } finally {
                await second.host.emit("session_shutdown", second.ctx);
                removeTempWorkDir(firstDir);
                removeTempWorkDir(secondDir);
            }
        });
    });

    describe("session_shutdown", () => {
        it("clears the dock and drops the jobs", async () => {
            const workDir = createTempWorkDir("shutdown-clears");
            const session = await openSession(workDir);
            try {
                const running = startJob("job-1", "sleep 30", workDir);
                assert.match(dockText(session.ui) ?? "", /^1 running shell · sleep 30 · \d+s · \/shell to open$/);

                await session.host.emit("session_shutdown", session.ctx);

                assert.equal(dockLine(session.ui), undefined, "the dock must be cleared on shutdown");
                assert.deepEqual(shellManager.getAllJobsList(), [], "shutdown must drop the jobs");
                assert.equal(running.signal.aborted, true, "shutdown must stop the shells it was tracking");
            } finally {
                removeTempWorkDir(workDir);
            }
        });

        it("stops rendering after the session ended", async () => {
            // Contract: session_shutdown unsubscribes, so a late job mutation cannot reach a dead
            // session's context (pi may have replaced its UI already).
            const workDir = createTempWorkDir("shutdown-unsubscribe");
            const session = await openSession(workDir);
            try {
                await session.host.emit("session_shutdown", session.ctx);
                const callsAfterShutdown = dockCalls(session.ui);

                startJob("late", "sleep 5", workDir);

                assert.equal(dockCalls(session.ui), callsAfterShutdown, "no render may happen after shutdown");
            } finally {
                removeTempWorkDir(workDir);
            }
        });
    });

    describe("background tool calls", () => {
        it("shows a running background shell in the dock and the settled shell afterwards", async () => {
            // Contract: end to end, one real background call makes the dock appear while the command
            // runs and turns it into the completed summary once the job settles.
            await withSession("call-dock", async (session) => {
                const { jobId } = await startBackgroundBashCommand(session.tool, {
                    command: "sleep 1; echo hi",
                    ctx: session.ctx,
                    toolCallId: "call-dock",
                });

                assert.match(dockText(session.ui) ?? "", /^1 running shell · sleep 1; echo hi · \d+s · \/shell to open$/);

                const settled = await waitForJobSettled(jobId);

                assert.equal(settled.output.content, "hi\n");
                assert.match(dockText(session.ui) ?? "", /^1 shell completed in \d+s · \/shell to open$/);
            });
        });

        it("re-renders the dock while background output streams", async () => {
            // Contract: every appended chunk reaches the subscriber, so the dock is re-mounted while
            // the command is still running - not only when the job settles.
            await withSession("call-stream-renders", async (session) => {
                const { jobId } = await startBackgroundBashCommand(session.tool, {
                    command: "printf 'one\\n'; sleep 0.2; printf 'two\\n'; sleep 0.2; printf 'three\\n'",
                    ctx: session.ctx,
                    toolCallId: "call-stream-renders",
                });
                const callsAfterStart = dockCalls(session.ui);

                const settled = await waitForJobSettled(jobId);

                assert.equal(settled.output.content, "one\ntwo\nthree\n");
                assert.ok(
                    dockCalls(session.ui) > callsAfterStart,
                    "expected the streamed chunks to re-render the dock",
                );
                assert.match(dockText(session.ui) ?? "", /^1 shell completed in \d+s · \/shell to open$/);
            });
        });
    });
});
