/**
 * Session lifecycle contract of pi-shell-view.
 *
 * The extension keeps the shared `ShellManager` in sync with the session: `session_start` empties
 * the job list, renders the dock and subscribes it to every later job mutation; `session_shutdown`
 * unsubscribes, clears the dock and drops the jobs. Around the delegated call, the tool records one
 * shell job per pi tool call and moves it through running -> completed / failed / stopped. These
 * tests drive real bash calls inside a fake session and assert both halves: the job the manager
 * holds and the widget calls the session's UI received.
 *
 * The extension's debug announcements (`ctx.ui.notify` on session start and before a command) are
 * intentionally not asserted here: they exist for manual debugging and are expected to grow, so the
 * tests must tolerate new ones. Because those announcements go through the context captured by
 * `session_start`, every test that executes the tool starts its session first.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { shellManager, type ShellJobStatus } from "../../src/shell/shell-manager.ts";
import { getFixture } from "../fixtures/long-running-scripts.ts";
import {
    createFakeContext,
    createFakeUi,
    createTempWorkDir,
    openSession,
    removeTempWorkDir,
    requireError,
    requireResult,
    resultText,
    runBashCommand,
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

/** Widget calls that mounted or cleared the shell dock. */
function dockCalls(ui: FakeExtensionUi): number {
    return ui.widgetCalls.filter((call) => call.key === WIDGET_ID).length;
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
            shellManager.startJob({ id: "stale", command: "sleep 999", cwd: "/tmp" });

            await withSession("start-empty", async (session) => {
                assert.deepEqual(shellManager.getAllJobsList(), [], "starting a session must drop stale jobs");
                assert.equal(dockLine(session.ui), undefined);
                assert.deepEqual(session.ui.widgetCalls.at(-1)?.content, undefined, "the dock must be cleared");
            });
        });

        it("renders the dock on every later job mutation", async () => {
            // Contract: the subscription installed by session_start is what makes the dock follow the
            // manager; without it a job change would never reach pi.
            await withSession("start-subscribe", async (session) => {
                assert.equal(dockCalls(session.ui), 1, "session_start renders once");

                shellManager.startJob({ id: "job-1", command: "sleep 30", cwd: "/tmp" });
                assert.deepEqual(dockLine(session.ui), ["  Shells · 1 shells · 1 running · sleep 30"]);

                shellManager.completeJob("job-1", "done");
                assert.deepEqual(dockLine(session.ui), ["  Shells · 1 shells · 1 completed"]);

                assert.equal(dockCalls(session.ui), 3, "expected one render per mutation");
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

                shellManager.startJob({ id: "job-1", command: "sleep 30", cwd: "/tmp" });

                assert.equal(dockCalls(first.ui), firstCallsAfterShutdown, "the ended session must not render again");
                assert.equal(dockCalls(second.ui), secondCallsAfterStart + 1, "the new session must render");
                assert.deepEqual(dockLine(second.ui), ["  Shells · 1 shells · 1 running · sleep 30"]);
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
                shellManager.startJob({ id: "job-1", command: "sleep 30", cwd: workDir });
                assert.deepEqual(dockLine(session.ui), ["  Shells · 1 shells · 1 running · sleep 30"]);

                await session.host.emit("session_shutdown", session.ctx);

                assert.equal(dockLine(session.ui), undefined, "the dock must be cleared on shutdown");
                assert.deepEqual(shellManager.getAllJobsList(), [], "shutdown must drop the jobs");
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

                shellManager.startJob({ id: "late", command: "sleep 5", cwd: workDir });

                assert.equal(dockCalls(session.ui), callsAfterShutdown, "no render may happen after shutdown");
            } finally {
                removeTempWorkDir(workDir);
            }
        });
    });

    describe("tool calls", () => {
        it("records one job per tool call and completes it with the reported output", async () => {
            // Contract: the tool call id becomes the job id and ctx.cwd becomes the job cwd, so a
            // dock entry can be traced back to the call that produced it.
            await withSession("call-completed", async (session) => {
                const run = await runBashCommand(session.tool, {
                    command: "printf 'hello\\n'",
                    ctx: session.ctx,
                    toolCallId: "call-completed",
                });

                const job = shellManager.getJob("call-completed");
                assert.ok(job, "expected the call to be recorded as a job");
                assert.equal(job.command, "printf 'hello\\n'");
                assert.equal(job.cwd, session.ctx.cwd);
                assert.equal(job.status, "completed");
                assert.equal(job.output, resultText(requireResult(run)));
                assert.equal(job.output, "hello\n");
                assert.ok(job.finishedAt !== undefined && job.finishedAt >= job.startedAt);
            });
        });

        it("keeps the job running and up to date while output streams", async () => {
            // Contract: every onUpdate snapshot is recorded before it is forwarded, so the dock shows
            // the same text the caller receives while the command is still running.
            const fixture = getFixture("progress");

            await withSession("call-streaming", async (session) => {
                const observed: Array<{ status: ShellJobStatus | undefined; output: string }> = [];

                const run = await runBashCommand(session.tool, {
                    command: fixture.command,
                    ctx: session.ctx,
                    toolCallId: "call-streaming",
                    onUpdate: (update) => {
                        const job = shellManager.getJob("call-streaming");
                        assert.equal(job?.output, resultText(update), "the job output must match the forwarded snapshot");
                        if (job) {
                            observed.push({ status: job.status, output: job.output });
                        }
                    },
                });

                assert.equal(run.failed, false, `expected the fixture to succeed: ${run.error?.message ?? ""}`);
                assert.ok(observed.length > 0, "expected at least one streamed snapshot");
                for (const snapshot of observed) {
                    assert.equal(snapshot.status, "running", "the job must stay running while output streams");
                }

                assert.equal(shellManager.getJob("call-streaming")?.status, "completed");
                assert.equal(shellManager.getJob("call-streaming")?.output, resultText(requireResult(run)));
            });
        });

        it("marks a non-zero exit as failed and keeps the built-in error message", async () => {
            // Contract: the extension classifies the thrown built-in error; without an aborted signal
            // a failed command becomes a failed job. The extension forwards only the message, so the
            // exit code pi parsed out of it is not recorded on the job.
            await withSession("call-failed", async (session) => {
                const run = await runBashCommand(session.tool, {
                    command: "printf 'before failure\\n'; exit 3",
                    ctx: session.ctx,
                    toolCallId: "call-failed",
                });
                const error = requireError(run);

                const job = shellManager.getJob("call-failed");
                assert.ok(job);
                assert.equal(job.status, "failed");
                assert.ok(job.error?.includes("Command exited with code 3"), `expected the built-in status line, got ${JSON.stringify(job.error)}`);
                assert.equal(job.error, error.message, "the job must record the error the caller received");
                assert.equal(job.exitCode, undefined, "the extension does not forward an exit code");
                assert.equal(job.output, "before failure\n", "output streamed before the failure must survive");
            });
        });

        it("marks a timed-out command as failed rather than stopped", async () => {
            // Contract: a timeout cancels the command without aborting the call's signal, so the job is
            // a failure and not a user cancellation.
            await withSession("call-timeout", async (session) => {
                const run = await runBashCommand(session.tool, {
                    command: "sleep 5",
                    timeout: 1,
                    ctx: session.ctx,
                    toolCallId: "call-timeout",
                });

                assert.equal(requireError(run).message, "Command timed out after 1 seconds");
                const job = shellManager.getJob("call-timeout");
                assert.ok(job);
                assert.equal(job.status, "failed");
                assert.equal(job.error, "Command timed out after 1 seconds");
                assert.equal(job.exitCode, undefined);
            });
        });

        it("marks an aborted command as stopped", async () => {
            // Contract: the aborted signal is what separates a cancellation from a failure.
            await withSession("call-aborted", async (session) => {
                const controller = new AbortController();
                const abortTimer = setTimeout(() => controller.abort(), 200);
                try {
                    const run = await runBashCommand(session.tool, {
                        command: "sleep 5",
                        signal: controller.signal,
                        ctx: session.ctx,
                        toolCallId: "call-aborted",
                    });

                    assert.equal(requireError(run).message, "Command aborted");
                    const job = shellManager.getJob("call-aborted");
                    assert.ok(job);
                    assert.equal(job.status, "stopped");
                    assert.equal(job.error, "Command aborted");
                    assert.equal(job.exitCode, undefined);
                } finally {
                    clearTimeout(abortTimer);
                }
            });
        });

        it("rejects a tool call id that is already running", async () => {
            // Contract: pi tool call ids are unique, so reusing one while it runs is a caller bug; the
            // manager refuses the second start and the first job keeps running.
            const fixture = getFixture("progress");

            await withSession("call-duplicate", async (session) => {
                const running = runBashCommand(session.tool, {
                    command: fixture.command,
                    ctx: session.ctx,
                    toolCallId: "call-duplicate",
                });

                const duplicate = await runBashCommand(session.tool, {
                    command: "echo duplicate",
                    ctx: session.ctx,
                    toolCallId: "call-duplicate",
                });
                const error = requireError(duplicate);
                assert.match(error.message, /Shell job already exists: call-duplicate/);
                assert.equal(shellManager.getJob("call-duplicate")?.status, "running", "the original job must survive");

                const first = await running;
                assert.equal(first.failed, false, `the original call must still succeed: ${first.error?.message ?? ""}`);
                assert.equal(shellManager.getJob("call-duplicate")?.status, "completed");
            });
        });

        it("fails before recording a job when pi passes no extension context", async () => {
            // Contract: the tool reads ctx.cwd for the job and for the delegated execution, and pi
            // always supplies the context. A context-less call fails immediately, without touching the
            // job list or the dock.
            await withSession("call-without-context", async (session) => {
                const callsBefore = dockCalls(session.ui);

                const run = await runBashCommand(session.tool, {
                    command: "echo no-context",
                    ctx: null,
                    toolCallId: "call-no-context",
                });

                assert.equal(run.failed, true, "a context-less call must fail");
                assert.equal(shellManager.getJob("call-no-context"), undefined, "no job may be recorded");
                assert.equal(dockCalls(session.ui), callsBefore, "the dock must not react");
            });
        });

        it("shows a running job in the dock and the settled job afterwards", async () => {
            // Contract: end to end, one real call makes the dock appear while the command runs and
            // keeps it after the call settles.
            await withSession("call-dock", async (session) => {
                const runningJob = runBashCommand(session.tool, {
                    command: "sleep 1; printf 'late\\n'",
                    ctx: session.ctx,
                    toolCallId: "call-dock",
                });

                assert.deepEqual(dockLine(session.ui), ["  Shells · 1 shells · 1 running · sleep 1; printf 'late\\n'"]);

                await runningJob;

                assert.deepEqual(dockLine(session.ui), ["  Shells · 1 shells · 1 completed"]);
            });
        });

        it("records jobs for parallel calls independently", async () => {
            // Contract: pi runs sibling tool calls concurrently, so the manager must key jobs by tool
            // call id and keep each one's own command, status and output.
            await withSession("call-parallel", async (session) => {
                const [slow, fast] = await Promise.all([
                    runBashCommand(session.tool, { command: "sleep 0.5; printf 'slow\\n'", ctx: session.ctx, toolCallId: "call-slow" }),
                    runBashCommand(session.tool, { command: "printf 'fast\\n'", ctx: session.ctx, toolCallId: "call-fast" }),
                ]);

                const slowJob = shellManager.getJob("call-slow");
                const fastJob = shellManager.getJob("call-fast");
                assert.ok(slowJob && fastJob);
                assert.equal(slowJob.command, "sleep 0.5; printf 'slow\\n'");
                assert.equal(slowJob.output, resultText(requireResult(slow)));
                assert.equal(fastJob.command, "printf 'fast\\n'");
                assert.equal(fastJob.output, resultText(requireResult(fast)));
                assert.equal(shellManager.getRunningJobsList().length, 0, "both jobs must be settled");
            });
        });
    });
});
