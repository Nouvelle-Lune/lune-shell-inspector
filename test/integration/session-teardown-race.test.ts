/**
 * Teardown races of the background shell runner.
 *
 * A detached shell and the session that started it end independently: the command can finish (or
 * print) at the exact moment `session_shutdown` clears the job list. These tests drive real commands
 * through the registered `bash` tool and assert the invariants that keep such a race harmless:
 *
 * - one job settles at most once, whichever path wins;
 * - a job aborted by teardown is never settled a second time by the runner's rejection handler;
 * - output that arrives after the job was dropped cannot escape as an uncaught error;
 * - a large output burst followed by shutdown does not crash the process.
 *
 * `uncaughtException` / `unhandledRejection` are collected for the duration of a test instead of
 * being allowed to fail the whole file, and asserted empty at the end. That is deliberate - a
 * runner that lets a stream callback throw turns into a process-level crash, which is exactly the
 * defect being guarded here.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { shellManager } from "../../src/shell/shell-manager.ts";
import {
    createFakeContext,
    createFakeUi,
    createTempWorkDir,
    registerExtension,
    removeTempWorkDir,
    startBackgroundBashCommand,
    waitFor,
    type BashToolDefinition,
} from "../harness.ts";

/** Process-level failures collected while one test runs. */
class ProcessFailureCollector {
    readonly failures: unknown[] = [];
    private readonly onUncaught = (error: unknown): void => {
        this.failures.push(error);
    };
    private readonly onUnhandled = (reason: unknown): void => {
        this.failures.push(reason);
    };

    start(): void {
        process.on("uncaughtException", this.onUncaught);
        process.on("unhandledRejection", this.onUnhandled);
    }

    stop(): void {
        process.off("uncaughtException", this.onUncaught);
        process.off("unhandledRejection", this.onUnhandled);
    }

    /** Give the event loop a few turns so a queued rejection is actually delivered. */
    async settle(): Promise<void> {
        for (let turn = 0; turn < 5; turn++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    assertEmpty(message: string): void {
        assert.deepEqual(
            this.failures.map((failure) => String(failure)),
            [],
            message,
        );
    }
}

/** A loaded session for one test. */
async function openSession(workDir: string) {
    const host = registerExtension(workDir);
    const ui = createFakeUi();
    const ctx = createFakeContext(workDir, { ui });
    await host.emit("session_start", ctx);
    const tool = host.registeredTools.find((entry) => entry.name === "bash") as BashToolDefinition | undefined;
    assert.ok(tool, "the extension must register the bash tool");
    return { host, ctx, tool };
}

describe("lune-shell-inspector teardown races", () => {
    afterEach(() => {
        shellManager.clearAllJobs();
    });

    it("a completion racing session_shutdown settles the job exactly once", async () => {
        await withTempDir("race-settle", async (workDir) => {
            const session = await openSession(workDir);

            // A command with just enough work for the completion to race the shutdown.
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "printf 'done\\n'",
                ctx: session.ctx,
                toolCallId: "race-settle",
            });

            const settleEvents: string[] = [];
            const unsubscribe = shellManager.subscribe((event) => {
                if (
                    (event.type === "job-completed" || event.type === "job-failed" || event.type === "job-killed") &&
                    event.id === jobId
                ) {
                    settleEvents.push(event.type);
                }
            });

            await session.host.emit("session_shutdown", session.ctx);
            await waitFor(
                "the racing completion to be observed",
                () => shellManager.getJob(jobId) === undefined,
                1000,
            ).catch(() => {
                // The manager is empty after shutdown; a late settle is refused before this check runs.
            });
            unsubscribe();
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.equal(settleEvents.length, 1, `the job must settle once, saw ${settleEvents.join(", ")}`);
            assert.deepEqual(shellManager.getAllJobsList(), []);
            const stats = shellManager.getAllJobsStatusStat();
            const settled = stats.completedCount + stats.failedCount + stats.killedCount + stats.runningCount;
            assert.equal(settled, 0, "a cleared manager must count nothing");
        });
    });

    it("a rejected runner cannot settle a job that teardown already killed", async () => {
        await withTempDir("race-reject", async (workDir) => {
            const session = await openSession(workDir);
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "sleep 30",
                ctx: session.ctx,
                toolCallId: "race-reject",
            });
            assert.equal(shellManager.getJob(jobId)!.status, "running");

            await session.host.emit("session_shutdown", session.ctx);

            // The runner's abort rejection lands after the shutdown already killed and dropped the job.
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(shellManager.settleJob(jobId, { type: "killed", error: "aborted" }), false);
            assert.equal(shellManager.settleJob(jobId, { type: "completed", exitCode: 0 }), false);
            assert.deepEqual(shellManager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            });
        });
    });

    it("output that keeps arriving after the shutdown kills the process is not appended any more", async () => {
        await withTempDir("race-flood", async (workDir) => {
            const failures = new ProcessFailureCollector();
            failures.start();
            const session = await openSession(workDir);

            try {
                const { jobId } = await startBackgroundBashCommand(session.tool, {
                    // An endless stream: the job is guaranteed to have chunks in flight when it is cleared.
                    command: "while true; do echo flooding; done",
                    ctx: session.ctx,
                    toolCallId: "race-flood",
                });

                await waitFor(
                    "the flood to produce output",
                    () => (shellManager.getJob(jobId)?.output.content.length ?? 0) > 0,
                );
                await waitFor(
                    "the flood to keep producing output",
                    () => (shellManager.getJob(jobId)?.output.totalBytes ?? 0) > 4096,
                );

                await session.host.emit("session_shutdown", session.ctx);
                const bytesAtShutdown = shellManager.getJob(jobId)?.output.totalBytes;
                assert.equal(bytesAtShutdown, undefined, "shutdown drops the job");

                // Any chunk that was still buffered must be refused, not crash the process.
                await failures.settle();
                failures.assertEmpty("a chunk arriving after teardown must not escape as a process error");
                assert.deepEqual(shellManager.getAllJobsList(), []);
            } finally {
                failures.stop();
            }
        });
    });

    it("killing a job through teardown makes the runner's abort path a no-op", async () => {
        await withTempDir("race-abort-path", async (workDir) => {
            const session = await openSession(workDir);
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "printf 'start\\n'; sleep 30",
                ctx: session.ctx,
                toolCallId: "race-abort-path",
            });
            await waitFor(
                "the command's first chunk",
                () => (shellManager.getJob(jobId)?.output.content ?? "").includes("start"),
            );

            await session.host.emit("session_shutdown", session.ctx);
            // The runner observes the abort and calls settleJob(killed); the job is gone by then.
            await new Promise((resolve) => setTimeout(resolve, 150));

            assert.deepEqual(shellManager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            });
            const snapshot = session.host.appendEntryCalls.at(-1);
            assert.equal(snapshot?.customType, "lune-shell-view-status");
            const jobs = (snapshot?.data as { jobs: Array<{ id: string; status: string }> }).jobs;
            assert.deepEqual(jobs.map((job) => [job.id, job.status]), [["race-abort-path", "killed"]]);
        });
    });
});

/** Run a test body with a temporary working directory. */
async function withTempDir(label: string, body: (workDir: string) => Promise<void>): Promise<void> {
    const workDir = createTempWorkDir(label);
    try {
        await body(workDir);
    } finally {
        removeTempWorkDir(workDir);
    }
}
