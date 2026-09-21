/**
 * Unit tests for the `ShellManager` state machine.
 *
 * The manager is the model behind the shell dock: every lifecycle method mutates one job and then
 * notifies its subscribers, which is what triggers a dock re-render. The tests lock the observable
 * contract - job fields and their timestamps, the status transitions each method accepts, the
 * errors raised for unknown ids, duplicate ids and illegal transitions, and the notification
 * semantics (synchronous, once per mutation, unsubscribe-able) including the behaviour of a
 * subscriber that throws.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ShellManager, shellManager, type ShellJob } from "../../src/shell/shell-manager.ts";

/** Start a job that is left running. */
function startRunningJob(
    manager: ShellManager,
    overrides: Partial<{ id: string; command: string; cwd: string }> = {},
): void {
    manager.startJob({
        id: overrides.id ?? "job-1",
        command: overrides.command ?? "sleep 5",
        cwd: overrides.cwd ?? "/tmp",
    });
}

describe("ShellManager", () => {
    describe("exported singleton", () => {
        it("exposes one shared manager instance for the extension", () => {
            // Contract: the module exports a ready-made ShellManager so every session handler and
            // tool call in one pi process observes the same job list.
            assert.ok(shellManager instanceof ShellManager, "shellManager must be a ShellManager instance");

            shellManager.clearAllJobs();
            startRunningJob(shellManager, { id: "singleton-job" });
            assert.equal(shellManager.getJob("singleton-job")?.status, "running");
            shellManager.clearAllJobs();
        });
    });

    describe("startJob", () => {
        it("stores a running job with an empty output and matching timestamps", () => {
            // Contract: a started job is immediately "running", carries the command and cwd it was
            // given, has no output yet and reports no finishedAt/exitCode/error.
            const manager = new ShellManager();
            const before = Date.now();
            startRunningJob(manager, { id: "job-a", command: "npm test", cwd: "/work" });
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

    describe("completeJob", () => {
        it("finishes a running job with the reported output", () => {
            // Contract: completion replaces the streamed output with the final text, stamps
            // finishedAt/lastActivityAt and keeps the creation timestamp.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const startedAt = manager.getJob("job-a")?.startedAt;

            manager.completeJob("job-a", "final output");

            const job = manager.getJob("job-a");
            assert.ok(job);
            assert.equal(job.status, "completed");
            assert.equal(job.output, "final output");
            assert.equal(job.startedAt, startedAt);
            assert.ok(job.finishedAt !== undefined && job.finishedAt >= job.startedAt);
            assert.equal(job.lastActivityAt, job.finishedAt, "the finish is the last activity");
            assert.equal(job.error, undefined);
        });

        it("rejects an unknown id", () => {
            const manager = new ShellManager();
            assert.throws(() => manager.completeJob("missing", "output"), /Unknown shell job: missing/);
        });

        it("rejects a job that is not running", () => {
            // Contract: completion is a running -> completed transition; a second completion (or one
            // after a failure) is rejected instead of rewriting the outcome.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.completeJob("job-a", "first");

            assert.throws(() => manager.completeJob("job-a", "second"), /Shell job "job-a" is not running: completed/);
            assert.equal(manager.getJob("job-a")?.output, "first", "the first result must survive");

            startRunningJob(manager, { id: "job-b" });
            manager.failJob("job-b", "boom");
            assert.throws(() => manager.completeJob("job-b", "late"), /Shell job "job-b" is not running: failed/);
        });
    });

    describe("failJob", () => {
        it("records the error and optional exit code", () => {
            // Contract: a failure keeps the streamed output, records the message and the exit code
            // when the caller has one.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.updateOutput("job-a", "partial output");

            manager.failJob("job-a", "Command exited with code 3", 3);

            const job = manager.getJob("job-a");
            assert.ok(job);
            assert.equal(job.status, "failed");
            assert.equal(job.error, "Command exited with code 3");
            assert.equal(job.exitCode, 3);
            assert.equal(job.output, "partial output", "a failure must not discard the streamed output");
            assert.ok(job.finishedAt !== undefined);
            assert.equal(job.lastActivityAt, job.finishedAt);
        });

        it("leaves exitCode undefined when none is supplied", () => {
            // Contract: the extension only forwards an error message, so a failed tool call without an
            // exit code must stay distinguishable from a job that exited with code 0.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            manager.failJob("job-a", "Command timed out after 1 seconds");

            assert.equal(manager.getJob("job-a")?.exitCode, undefined);
        });

        it("rejects an unknown id and a job that is not running", () => {
            const manager = new ShellManager();
            assert.throws(() => manager.failJob("missing", "boom"), /Unknown shell job: missing/);

            startRunningJob(manager, { id: "job-a" });
            manager.stopJob("job-a", "Command aborted");
            assert.throws(() => manager.failJob("job-a", "boom"), /Shell job "job-a" is not running: stopped/);
        });
    });

    describe("stopJob", () => {
        it("records the abort reason without an exit code", () => {
            // Contract: a stopped job is a cancelled call, not a failure with a process exit code.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            manager.stopJob("job-a", "Command aborted");

            const job = manager.getJob("job-a");
            assert.ok(job);
            assert.equal(job.status, "stopped");
            assert.equal(job.error, "Command aborted");
            assert.equal(job.exitCode, undefined);
            assert.ok(job.finishedAt !== undefined);
            assert.equal(job.lastActivityAt, job.finishedAt);
        });

        it("rejects an unknown id and a job that is not running", () => {
            const manager = new ShellManager();
            assert.throws(() => manager.stopJob("missing", "Command aborted"), /Unknown shell job: missing/);

            startRunningJob(manager, { id: "job-a" });
            manager.completeJob("job-a", "done");
            assert.throws(() => manager.stopJob("job-a", "Command aborted"), /Shell job "job-a" is not running: completed/);
        });
    });

    describe("clearAllJobs", () => {
        it("drops every job regardless of status", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "running" });
            startRunningJob(manager, { id: "completed" });
            manager.completeJob("completed", "done");
            startRunningJob(manager, { id: "failed" });
            manager.failJob("failed", "boom");

            manager.clearAllJobs();

            assert.deepEqual(manager.getAllJobsList(), []);
            assert.deepEqual(manager.getRunningJobsList(), []);
            assert.equal(manager.getJob("running"), undefined);
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

        it("rejects an unknown id", () => {
            const manager = new ShellManager();
            assert.throws(() => manager.updateOutput("missing", "output"), /Unknown shell job: missing/);
        });

        it("rejects a job that already finished", () => {
            // Contract: updateOutput is a running-only operation, so a late onUpdate snapshot cannot
            // overwrite the settled result.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "completed" });
            manager.completeJob("completed", "final");
            startRunningJob(manager, { id: "failed" });
            manager.failJob("failed", "boom");
            startRunningJob(manager, { id: "stopped" });
            manager.stopJob("stopped", "Command aborted");

            assert.throws(
                () => manager.updateOutput("completed", "late"),
                /Cannot update output for shell job "completed" in status "completed"/,
            );
            assert.throws(() => manager.updateOutput("failed", "late"), /in status "failed"/);
            assert.throws(() => manager.updateOutput("stopped", "late"), /in status "stopped"/);
            assert.equal(manager.getJob("completed")?.output, "final");
        });
    });

    describe("queries", () => {
        it("returns undefined for an unknown job and the stored job for a known one", () => {
            const manager = new ShellManager();
            assert.equal(manager.getJob("missing"), undefined);

            startRunningJob(manager, { id: "job-a", command: "echo a" });

            assert.equal(manager.getJob("job-a")?.command, "echo a");
        });

        it("lists jobs in insertion order and running jobs only in the same order", () => {
            // Contract: the dock picks the latest running job, which it derives from this order.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "first", command: "sleep 1" });
            startRunningJob(manager, { id: "second", command: "sleep 2" });
            manager.completeJob("first", "done");
            startRunningJob(manager, { id: "third", command: "sleep 3" });

            assert.deepEqual(
                manager.getAllJobsList().map((job) => job.id),
                ["first", "second", "third"],
            );
            assert.deepEqual(
                manager.getRunningJobsList().map((job) => job.id),
                ["second", "third"],
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

            manager.completeJob("job-1", "done");
            assert.deepEqual(seen, ["first", "added", "first", "added"]);
        });
    });
});
