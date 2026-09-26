/**
 * Lifecycle kills versus agent notifications.
 *
 * A session lifecycle can stop a running background shell without any human action: leaving a
 * branch (`session_before_tree`) and ending a session (`session_shutdown`) both run
 * `clearAllJobs()`, which settles every running job as killed. Those kills are bookkeeping, not
 * results a user asked for, so the agent must not be interrupted with a completion notification
 * for them - while an explicit user kill through the inspector still notifies (covered by
 * `test/integration/inspector-kill.test.ts`).
 *
 * These tests drive the real extension and pi's own session events through `test/harness.ts`. The
 * desired contract for the tree kill is currently expected to fail: the notification listener is
 * still subscribed while `session_before_tree` runs, so today the lifecycle kill notifies.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { FakePiHost } from "../harness.ts";
import {
    FakeSessionLog,
    createTempWorkDir,
    openSession,
    removeTempWorkDir,
    startBackgroundBashCommand,
    type SendMessageCall,
} from "../harness.ts";
import { shellManager } from "../../src/shell/shell-manager.ts";

/** Custom entry type one persisted shell view snapshot is written under. */
const SHELL_STATUS_ENTRY = "lune-shell-view-status";

/** One persisted snapshot as the tests read it. */
interface Snapshot {
    jobs: Array<{ id: string; status: string; error?: string }>;
    stats: Record<string, number>;
}

/** The newest shell view snapshot the host persisted, if any. */
function lastSnapshot(host: FakePiHost): Snapshot | undefined {
    const call = [...host.appendEntryCalls].reverse().find((entry) => entry.customType === SHELL_STATUS_ENTRY);
    return call?.data as Snapshot | undefined;
}

/** Messages that asked pi to start an agent turn. */
function turnTriggers(host: FakePiHost): readonly SendMessageCall[] {
    return host.sendMessageCalls.filter((call) => call.options?.triggerTurn === true);
}

/** Messages sent under one custom type, in call order. */
function notificationsOfType(host: FakePiHost, customType: string): readonly SendMessageCall[] {
    return host.sendMessageCalls.filter((call) => call.message.customType === customType);
}

/** pi's `session_before_tree` payload, as pi emits it before moving the leaf. */
function treePreparation(log: FakeSessionLog): Record<string, unknown> {
    return {
        preparation: {
            targetId: log.leafId,
            oldLeafId: log.leafId,
            commonAncestorId: null,
            entriesToSummarize: [],
            userWantsSummary: false,
        },
        signal: new AbortController().signal,
    };
}

describe("lune-shell-inspector lifecycle notifications", () => {
    beforeEach(() => {
        shellManager.clearAllJobs();
    });

    afterEach(() => {
        shellManager.clearAllJobs();
    });

    it("kills a running shell on session_before_tree without notifying the agent", async () => {
        const workDir = createTempWorkDir("tree-kill-single");
        const sessionLog = new FakeSessionLog({ cwd: workDir });
        const session = await openSession(workDir, { sessionLog });

        try {
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "sleep 30",
                ctx: session.ctx,
                toolCallId: "call-tree-kill",
            });
            const running = shellManager.getJob(jobId)!;
            assert.equal(running.status, "running");

            await session.host.emit("session_before_tree", session.ctx, treePreparation(sessionLog));

            assert.equal(running.controller.signal.aborted, true, "leaving the branch must stop the shell");
            assert.equal(shellManager.getJob(jobId), undefined, "the lifecycle kill drops the runtime job");

            const snapshot = lastSnapshot(session.host);
            assert.ok(snapshot, "the lifecycle kill must persist a snapshot");
            assert.deepEqual(
                snapshot.jobs.map((job) => [job.id, job.status]),
                [[jobId, "killed"]],
                "the departing branch must record the shell as killed",
            );

            assert.deepEqual(session.host.sendMessageCalls, [], "a lifecycle kill must not notify the agent");
            assert.deepEqual(
                notificationsOfType(session.host, "background-shell-notification"),
                [],
                "no background-shell notification may be sent for this lifecycle kill",
            );
            assert.deepEqual(turnTriggers(session.host), [], "a lifecycle kill must not trigger an agent turn");

            // `session_tree` restores the just-persisted branch state.
            await session.host.emit("session_tree", session.ctx, {
                newLeafId: sessionLog.leafId,
                oldLeafId: sessionLog.leafId,
            });

            const restored = shellManager.getJob(jobId);
            assert.ok(restored, "the branch's snapshot must restore the killed shell");
            assert.equal(restored.status, "killed");
            assert.equal(restored.error, "pi session shutdown");
            assert.equal(restored.controller.signal.aborted, false, "a restored job is inert state");
            assert.deepEqual(shellManager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 1,
            });
        } finally {
            await session.host.emit("session_shutdown", session.ctx);
            removeTempWorkDir(workDir);
        }
    });

    it("kills every running shell on session_before_tree without notifying for any of them", async () => {
        const workDir = createTempWorkDir("tree-kill-many");
        const sessionLog = new FakeSessionLog({ cwd: workDir });
        const session = await openSession(workDir, { sessionLog });

        try {
            const ids = ["call-tree-a", "call-tree-b", "call-tree-c"];
            const controllers: AbortController[] = [];
            for (const id of ids) {
                await startBackgroundBashCommand(session.tool, {
                    command: `sleep 30 # ${id}`,
                    ctx: session.ctx,
                    toolCallId: id,
                });
                assert.equal(shellManager.getJob(id)?.status, "running");
                controllers.push(shellManager.getJob(id)!.controller);
            }

            await session.host.emit("session_before_tree", session.ctx, treePreparation(sessionLog));

            assert.deepEqual(
                controllers.map((controller) => controller.signal.aborted),
                [true, true, true],
                "every running shell must be stopped",
            );
            const snapshot = lastSnapshot(session.host);
            assert.ok(snapshot);
            assert.deepEqual(
                snapshot.jobs.map((job) => [job.id, job.status]),
                ids.map((id) => [id, "killed"]),
                "every killed job must be persisted as killed",
            );
            assert.equal(snapshot.stats.killedCount, ids.length);
            assert.deepEqual(session.host.sendMessageCalls, [], "none of the lifecycle kills may notify");
            assert.deepEqual(
                notificationsOfType(session.host, "background-shell-notification"),
                [],
                "no background-shell notification may be sent for any lifecycle kill",
            );
            assert.deepEqual(turnTriggers(session.host), []);

            await session.host.emit("session_tree", session.ctx, {
                newLeafId: sessionLog.leafId,
                oldLeafId: sessionLog.leafId,
            });

            assert.deepEqual(
                shellManager.getAllJobsList().map((job) => [job.id, job.status]),
                ids.map((id) => [id, "killed"]),
                "the tree must restore every killed shell",
            );
            assert.deepEqual(shellManager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: ids.length,
            });
        } finally {
            await session.host.emit("session_shutdown", session.ctx);
            removeTempWorkDir(workDir);
        }
    });

    it("kills a running shell on session_shutdown without notifying and without a live subscription", async () => {
        const workDir = createTempWorkDir("shutdown-kill");
        const session = await openSession(workDir);

        try {
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "sleep 30",
                ctx: session.ctx,
                toolCallId: "call-shutdown-kill",
            });
            const running = shellManager.getJob(jobId)!;

            await session.host.emit("session_shutdown", session.ctx);

            assert.equal(running.controller.signal.aborted, true, "shutdown must stop the shell");
            assert.equal(shellManager.getJob(jobId), undefined, "shutdown drops the runtime job");
            assert.deepEqual(session.host.sendMessageCalls, [], "shutdown must not notify for the shells it kills");
            assert.deepEqual(turnTriggers(session.host), [], "shutdown must not trigger an agent turn");

            const snapshot = lastSnapshot(session.host);
            assert.equal(
                snapshot?.jobs.find((job) => job.id === jobId)?.status,
                "killed",
                "shutdown must persist the shell as killed",
            );

            // The notification subscription was removed before the clear: a later manager mutation
            // cannot reach the ended session.
            shellManager.startJob({
                id: "after-shutdown",
                command: "echo late",
                cwd: workDir,
                controller: new AbortController(),
            });
            shellManager.settleJob("after-shutdown", { type: "completed", exitCode: 0 });

            assert.deepEqual(session.host.sendMessageCalls, [], "the ended session must not be notified again");
            assert.deepEqual(turnTriggers(session.host), []);
        } finally {
            removeTempWorkDir(workDir);
        }
    });
});
