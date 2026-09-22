/**
 * Unit tests for the `ShellManager` state machine.
 *
 * The manager is the model behind the shell dock: every background shell is one job, and jobs move
 * from `running` to exactly one settled status through the single public entry point `settleJob`.
 * The tests lock the observable contract - job fields and their timestamps, the controller a job
 * owns, the two output writers (`appendOutput` for the raw chunks the background runner streams,
 * `updateOutput` for callers that replace the whole text), the outcome each settle accepts, the
 * idempotence of settling (a job that is unknown or already settled is refused without an event or
 * a counter change), the per-status counters, and the notification semantics (synchronous, once
 * per mutation, unsubscribe-able) including the behaviour of a subscriber that throws.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    ShellManager,
    shellManager,
    type ShellJob,
    type ShellJobOutcome,
} from "../../src/shell/shell-manager.ts";

/** Start a running job and return the controller stored with it. */
function startRunningJob(
    manager: ShellManager,
    overrides: Partial<{ id: string; command: string; cwd: string; controller: AbortController }> = {},
): AbortController {
    const controller = overrides.controller ?? new AbortController();
    manager.startJob({
        id: overrides.id ?? "job-1",
        command: overrides.command ?? "sleep 5",
        cwd: overrides.cwd ?? "/tmp",
        controller,
    });
    return controller;
}

/** Settle outcomes used by the tests. */
const completed = (exitCode?: number): ShellJobOutcome => ({ type: "completed", exitCode });
const failed = (error: string, exitCode?: number): ShellJobOutcome => ({ type: "failed", error, exitCode });
const killed = (error?: string): ShellJobOutcome => ({ type: "killed", error });

describe("ShellManager", () => {
    describe("exported singleton", () => {
        it("exposes one shared manager instance for the extension", () => {
            // Contract: the module exports a ready-made ShellManager so every session handler and
            // background tool call in one pi process observes the same job list.
            assert.ok(shellManager instanceof ShellManager, "shellManager must be a ShellManager instance");

            shellManager.clearAllJobs();
            startRunningJob(shellManager, { id: "singleton-job" });
            assert.equal(shellManager.getJob("singleton-job")?.status, "running");
            shellManager.clearAllJobs();
        });
    });

    describe("startJob", () => {
        it("stores a running job with an empty output, its controller and matching timestamps", () => {
            // Contract: a started job is immediately "running", carries the command, cwd and
            // controller it was given, has no output yet and reports no finishedAt/exitCode/error.
            const manager = new ShellManager();
            const controller = new AbortController();
            const before = Date.now();
            startRunningJob(manager, { id: "job-a", command: "npm test", cwd: "/work", controller });
            const after = Date.now();

            const job = manager.getJob("job-a");
            assert.ok(job, "expected the started job");
            assert.equal(job.id, "job-a");
            assert.equal(job.command, "npm test");
            assert.equal(job.cwd, "/work");
            assert.equal(job.status, "running");
            assert.equal(job.output, "");
            assert.equal(job.finishedAt, undefined);
            assert.equal(job.exitCode, undefined);
            assert.equal(job.error, undefined);
            assert.equal(job.controller, controller, "the job must keep the caller's controller");
            assert.equal(job.startedAt, job.lastActivityAt, "start and last activity share the creation timestamp");
            assert.ok(job.startedAt >= before && job.startedAt <= after, "startedAt must be the wall clock at creation");
        });

        it("rejects a duplicate id without touching the existing job", () => {
            // Contract: ids identify pi tool calls, so a second start with the same id is a bug in the
            // caller and must not silently replace the running job.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a", command: "first" });

            assert.throws(() => startRunningJob(manager, { id: "job-a", command: "second" }), /Shell job already exists: job-a/);
            assert.equal(manager.getJob("job-a")?.command, "first", "the original job must stay untouched");
        });

        it("notifies subscribers once, synchronously", () => {
            // Contract: subscribers are called while startJob runs, exactly once per mutation.
            const manager = new ShellManager();
            const seen: string[] = [];
            let jobsDuringNotification = -1;
            manager.subscribe(() => {
                seen.push("notified");
                jobsDuringNotification = manager.getAllJobsList().length;
            });

            startRunningJob(manager);

            assert.deepEqual(seen, ["notified"]);
            assert.equal(jobsDuringNotification, 1, "the job must already be stored when listeners run");
        });
    });

    describe("settleJob", () => {
        it("completes a running job with its exit code and keeps the streamed output", () => {
            // Contract: the background runner appends output while the command runs, so settling
            // only transitions the status and stamps the outcome; it never rewrites the output.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "line 1\n");
            const startedAt = manager.getJob("job-a")?.startedAt;

            assert.equal(manager.settleJob("job-a", completed(0)), true);

            const job = manager.getJob("job-a");
            assert.ok(job);
            assert.equal(job.status, "completed");
            assert.equal(job.output, "line 1\n", "settling must keep the streamed output");
            assert.equal(job.exitCode, 0);
            assert.equal(job.startedAt, startedAt);
            assert.ok(job.finishedAt !== undefined && job.finishedAt >= job.startedAt);
            assert.equal(job.lastActivityAt, job.finishedAt, "the finish is the last activity");
            assert.equal(job.error, undefined);
        });

        it("records a non-zero exit code as data on a completed job", () => {
            // Contract: the local bash operations resolve with the exit code of a finished process;
            // a non-zero code is recorded on the completed job, not turned into a failure.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            assert.equal(manager.settleJob("job-a", completed(3)), true);

            const job = manager.getJob("job-a");
            assert.ok(job);
            assert.equal(job.status, "completed");
            assert.equal(job.exitCode, 3);
            assert.equal(job.error, undefined);
        });

        it("leaves exitCode undefined for a completion without one", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            manager.settleJob("job-a", completed());

            assert.equal(manager.getJob("job-a")?.exitCode, undefined);
        });

        it("fails a running job with the error and optional exit code", () => {
            // Contract: a failure keeps the streamed output, records the message and the exit code
            // when the caller has one.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "partial output");

            assert.equal(manager.settleJob("job-a", failed("Command exited with code 3", 3)), true);

            const job = manager.getJob("job-a");
            assert.ok(job);
            assert.equal(job.status, "failed");
            assert.equal(job.error, "Command exited with code 3");
            assert.equal(job.exitCode, 3);
            assert.equal(job.output, "partial output", "a failure must not discard the streamed output");
            assert.ok(job.finishedAt !== undefined);
            assert.equal(job.lastActivityAt, job.finishedAt);
        });

        it("leaves exitCode undefined for a failure without one", () => {
            // Contract: an error without a process exit code must stay distinguishable from a job
            // that exited with code 0.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            manager.settleJob("job-a", failed("spawn failed"));

            assert.equal(manager.getJob("job-a")?.exitCode, undefined);
        });

        it("kills a running job by aborting its controller", () => {
            // Contract: a killed job is a cancelled process, not a failure with a process exit code:
            // the status is "killed", the reason is recorded, and the job's own AbortController is
            // what was fired.
            const manager = new ShellManager();
            const controller = startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "before kill");
            assert.equal(controller.signal.aborted, false);

            assert.equal(manager.settleJob("job-a", killed("timeout:1")), true);

            const job = manager.getJob("job-a");
            assert.ok(job);
            assert.equal(job.status, "killed");
            assert.equal(job.error, "timeout:1");
            assert.equal(job.exitCode, undefined);
            assert.equal(controller.signal.aborted, true, "killing a job must abort its controller");
            assert.equal(job.output, "before kill", "a kill must not discard the streamed output");
            assert.ok(job.finishedAt !== undefined);
            assert.equal(job.lastActivityAt, job.finishedAt);
        });

        it("uses a default reason when a kill carries none", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            manager.settleJob("job-a", killed());

            assert.equal(manager.getJob("job-a")?.error, "killed");
        });

        it("refuses an unknown id without an event or a counter change", () => {
            // Contract: the detached execution can settle after a session teardown dropped the job;
            // an unknown id is a silent refusal, not an error.
            const manager = new ShellManager();
            const seen: string[] = [];
            manager.subscribe(() => {
                seen.push("notified");
            });

            assert.equal(manager.settleJob("missing", completed(0)), false);

            assert.deepEqual(seen, [], "a refused settle must not notify subscribers");
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            });
        });

        it("is idempotent: a second settle is refused and the first outcome survives", () => {
            // Contract: a late settle (for example a completion racing an explicit kill) must not
            // overwrite the recorded outcome or move the counters twice.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            assert.equal(manager.settleJob("job-a", completed(3)), true);
            const settledAt = manager.getJob("job-a")?.finishedAt;
            const seen: string[] = [];
            manager.subscribe(() => {
                seen.push("notified");
            });

            assert.equal(manager.settleJob("job-a", failed("late")), false);
            assert.equal(manager.settleJob("job-a", killed("late")), false);

            const job = manager.getJob("job-a");
            assert.ok(job);
            assert.equal(job.status, "completed", "the first outcome must survive");
            assert.equal(job.exitCode, 3);
            assert.equal(job.error, undefined);
            assert.equal(job.finishedAt, settledAt);
            assert.deepEqual(seen, [], "refused settles must not re-render the dock");
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 1,
                failedCount: 0,
                killedCount: 0,
            });
        });

        it("keeps a killed job when a later completion arrives", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.settleJob("job-a", killed("manual"));

            assert.equal(manager.settleJob("job-a", completed(0)), false);
            assert.equal(manager.getJob("job-a")?.status, "killed");
        });
    });

    describe("clearAllJobs", () => {
        it("drops every job regardless of status and resets the counters", () => {
            const manager = new ShellManager();
            const runningController = startRunningJob(manager, { id: "running" });
            startRunningJob(manager, { id: "completed" });
            manager.settleJob("completed", completed(0));
            startRunningJob(manager, { id: "failed" });
            manager.settleJob("failed", failed("boom"));
            startRunningJob(manager, { id: "killed" });
            manager.settleJob("killed", killed("timeout:1"));

            manager.clearAllJobs();

            assert.equal(runningController.signal.aborted, true, "clearing must abort a running job's process");
            assert.deepEqual(manager.getAllJobsList(), []);
            assert.deepEqual(manager.getRunningJobsList(), []);
            assert.deepEqual(manager.getCompletedJobsList(), []);
            assert.equal(manager.getJob("running"), undefined);
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            });
        });

        it("aborts the running jobs and leaves settled ones alone", () => {
            // Contract: teardown must stop live processes, but aborting a settled job's controller
            // would fire on an execution that already ended.
            const manager = new ShellManager();
            const running = startRunningJob(manager, { id: "running" });
            const completedController = startRunningJob(manager, { id: "completed" });
            manager.settleJob("completed", completed(0));

            manager.clearAllJobs();

            assert.equal(running.signal.aborted, true);
            assert.equal(completedController.signal.aborted, false);
        });

        it("notifies subscribers even when it clears nothing", () => {
            // Contract: session_start both clears and renders, so an empty clear must still reach the
            // dock instead of leaving a stale widget behind.
            const manager = new ShellManager();
            const seen: number[] = [];
            manager.subscribe(() => {
                seen.push(manager.getAllJobsList().length);
            });

            manager.clearAllJobs();

            assert.deepEqual(seen, [0]);
        });
    });

    describe("updateOutput", () => {
        it("replaces the streamed output and bumps the activity timestamp", () => {
            // Contract: snapshots are cumulative and overwrite the previous text; only the activity
            // timestamp moves, so a running job keeps its creation time.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const startedAt = manager.getJob("job-a")?.startedAt;

            manager.updateOutput("job-a", "line 1\n");
            const firstActivity = manager.getJob("job-a")?.lastActivityAt;
            manager.updateOutput("job-a", "line 1\nline 2\n");

            const job = manager.getJob("job-a");
            assert.ok(job);
            assert.equal(job.output, "line 1\nline 2\n");
            assert.equal(job.status, "running");
            assert.equal(job.startedAt, startedAt);
            assert.ok(firstActivity !== undefined && job.lastActivityAt >= firstActivity);
            assert.equal(job.finishedAt, undefined, "streaming output must not finish the job");
        });

        it("notifies subscribers once per update", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const seen: string[] = [];
            manager.subscribe(() => {
                seen.push("notified");
            });

            manager.updateOutput("job-a", "one");
            manager.updateOutput("job-a", "one\ntwo");

            assert.deepEqual(seen, ["notified", "notified"]);
        });

        it("rejects an unknown id and a job that already finished", () => {
            // Contract: updateOutput is a running-only operation, so a late snapshot cannot overwrite
            // the settled result.
            const manager = new ShellManager();
            assert.throws(() => manager.updateOutput("missing", "output"), /Unknown shell job: missing/);

            startRunningJob(manager, { id: "completed" });
            manager.settleJob("completed", completed(0));
            startRunningJob(manager, { id: "failed" });
            manager.settleJob("failed", failed("boom"));
            startRunningJob(manager, { id: "killed" });
            manager.settleJob("killed", killed("timeout:1"));

            assert.throws(
                () => manager.updateOutput("completed", "late"),
                /Cannot update output for shell job "completed" in status "completed"/,
            );
            assert.throws(() => manager.updateOutput("failed", "late"), /in status "failed"/);
            assert.throws(() => manager.updateOutput("killed", "late"), /in status "killed"/);
            assert.equal(manager.getJob("completed")?.output, "");
        });
    });

    describe("appendOutput", () => {
        it("concatenates chunks in arrival order and bumps the activity timestamp", () => {
            // Contract: the background runner streams raw chunks, so appendOutput must grow the
            // output text instead of replacing it, and only move the activity timestamp.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const startedAt = manager.getJob("job-a")?.startedAt;

            manager.appendOutput("job-a", "chunk 1\n");
            const firstActivity = manager.getJob("job-a")?.lastActivityAt;
            manager.appendOutput("job-a", "chunk 2\n");
            manager.appendOutput("job-a", "chunk 3");

            const job = manager.getJob("job-a");
            assert.ok(job);
            assert.equal(job.output, "chunk 1\nchunk 2\nchunk 3");
            assert.equal(job.status, "running");
            assert.equal(job.startedAt, startedAt);
            assert.ok(firstActivity !== undefined && job.lastActivityAt >= firstActivity);
            assert.equal(job.finishedAt, undefined, "streaming output must not finish the job");
        });

        it("accepts an empty chunk without changing the output", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "kept");

            manager.appendOutput("job-a", "");

            assert.equal(manager.getJob("job-a")?.output, "kept");
        });

        it("notifies subscribers once per chunk", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const seen: string[] = [];
            manager.subscribe(() => {
                seen.push("notified");
            });

            manager.appendOutput("job-a", "one");
            manager.appendOutput("job-a", "two");

            assert.deepEqual(seen, ["notified", "notified"]);
        });

        it("rejects an unknown id and a job that already finished", () => {
            // Contract: appendOutput is the running-only writer, so late chunks cannot corrupt a
            // settled job's final output.
            const manager = new ShellManager();
            assert.throws(() => manager.appendOutput("missing", "late"), /Unknown shell job: missing/);

            startRunningJob(manager, { id: "completed" });
            manager.appendOutput("completed", "final");
            manager.settleJob("completed", completed(0));

            assert.throws(
                () => manager.appendOutput("completed", "late"),
                /Shell job "completed" is not running: completed/,
            );
            assert.equal(manager.getJob("completed")?.output, "final");
        });
    });

    describe("status counters", () => {
        it("counts every transition", () => {
            // Contract: the dock summary reads these counters instead of walking the job list, so
            // each transition must move exactly one job between the counters.
            const manager = new ShellManager();
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            });

            startRunningJob(manager, { id: "running" });
            assert.equal(manager.getAllJobsStatusStat().runningCount, 1);

            startRunningJob(manager, { id: "completed" });
            manager.settleJob("completed", completed(0));
            startRunningJob(manager, { id: "failed" });
            manager.settleJob("failed", failed("boom"));
            startRunningJob(manager, { id: "killed" });
            manager.settleJob("killed", killed("timeout:1"));

            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 1,
                completedCount: 1,
                failedCount: 1,
                killedCount: 1,
            });
        });

        it("exposes the live counters through the public field and a copy through the getter", () => {
            // Contract: the dock reads `jobsStatusStat` directly, so that field must stay live;
            // getAllJobsStatusStat() returns a snapshot so a caller cannot write through it.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            assert.equal(manager.jobsStatusStat.runningCount, 1);

            const snapshot = manager.getAllJobsStatusStat();
            snapshot.runningCount = 99;
            snapshot.completedCount = 99;

            assert.equal(manager.jobsStatusStat.runningCount, 1, "the getter must return a copy");
            assert.equal(manager.getAllJobsStatusStat().completedCount, 0);
        });
    });

    describe("queries", () => {
        it("returns undefined for an unknown job and the stored job for a known one", () => {
            const manager = new ShellManager();
            assert.equal(manager.getJob("missing"), undefined);

            startRunningJob(manager, { id: "job-a", command: "echo a" });

            assert.equal(manager.getJob("job-a")?.command, "echo a");
        });

        it("lists jobs in insertion order and running/completed jobs only in the same order", () => {
            // Contract: the dock picks the latest running job, which it derives from this order.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "first", command: "sleep 1" });
            startRunningJob(manager, { id: "second", command: "sleep 2" });
            manager.settleJob("first", completed(0));
            startRunningJob(manager, { id: "third", command: "sleep 3" });
            manager.settleJob("third", completed(0));

            assert.deepEqual(
                manager.getAllJobsList().map((job) => job.id),
                ["first", "second", "third"],
            );
            assert.deepEqual(
                manager.getRunningJobsList().map((job) => job.id),
                ["second"],
            );
            assert.deepEqual(
                manager.getCompletedJobsList().map((job) => job.id),
                ["first", "third"],
            );
        });

        it("returns the live job object rather than a copy", () => {
            // Contract: `Readonly<ShellJob>` is a compile-time guard only; pi's own tool callbacks all
            // run in one process, so a caller that writes through the reference is visible to everyone.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            const job = manager.getJob("job-a") as ShellJob;
            job.output = "written through the reference";

            assert.equal(manager.getAllJobsList().at(0)?.output, "written through the reference");
        });
    });

    describe("subscribe", () => {
        it("stops notifying after the returned unsubscribe runs", () => {
            const manager = new ShellManager();
            const seen: string[] = [];
            const unsubscribe = manager.subscribe(() => {
                seen.push("notified");
            });

            startRunningJob(manager, { id: "before" });
            unsubscribe();
            startRunningJob(manager, { id: "after" });

            assert.deepEqual(seen, ["notified"]);
            assert.doesNotThrow(() => unsubscribe(), "unsubscribing twice must be harmless");
        });

        it("registers the same listener only once", () => {
            // Contract: listeners live in a Set, so an accidental double subscription does not double
            // render the dock.
            const manager = new ShellManager();
            let calls = 0;
            const listener = (): void => {
                calls += 1;
            };

            manager.subscribe(listener);
            manager.subscribe(listener);
            startRunningJob(manager);

            assert.equal(calls, 1);
        });

        it("notifies every listener in registration order", () => {
            const manager = new ShellManager();
            const order: string[] = [];
            manager.subscribe(() => {
                order.push("first");
            });
            manager.subscribe(() => {
                order.push("second");
            });

            startRunningJob(manager);

            assert.deepEqual(order, ["first", "second"]);
        });

        it("lets a throwing listener abort the remaining notifications and the caller", () => {
            // Contract: emit() has no try/catch, so one failing listener both prevents the later
            // listeners from running and surfaces through the mutation call - while the mutation
            // itself has already been applied.
            const manager = new ShellManager();
            const seen: string[] = [];
            manager.subscribe(() => {
                seen.push("throwing");
                throw new Error("listener boom");
            });
            manager.subscribe(() => {
                seen.push("later");
            });

            assert.throws(() => startRunningJob(manager, { id: "job-a" }), /listener boom/);
            assert.deepEqual(seen, ["throwing"], "the later listener must not run");
            assert.equal(manager.getJob("job-a")?.status, "running", "the job was stored before listeners ran");
        });

        it("visits a listener added during a notification in the same emit", () => {
            // Contract: listeners are held in a Set and iterated live, so a listener that subscribes
            // another one during emit immediately runs the new listener too, and both keep running on
            // the next mutation.
            const manager = new ShellManager();
            const seen: string[] = [];
            let addedOnce = false;
            manager.subscribe(() => {
                seen.push("first");
                if (addedOnce) {
                    return;
                }
                addedOnce = true;
                manager.subscribe(() => {
                    seen.push("added");
                });
            });

            startRunningJob(manager, { id: "job-1" });
            assert.deepEqual(seen, ["first", "added"], "the live Set iteration must reach the new listener");

            manager.settleJob("job-1", completed(0));
            assert.deepEqual(seen, ["first", "added", "first", "added"]);
        });
    });
});
