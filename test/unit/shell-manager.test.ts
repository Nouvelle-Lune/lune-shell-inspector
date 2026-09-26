/**
 * Unit tests for the `ShellManager` state machine.
 *
 * The manager is the model behind the shell dock: every background shell is one job, and jobs move
 * from `running` to exactly one settled status through the single public entry point `settleJob`.
 * The tests lock the observable contract - job fields and their timestamps, the controller a job
 * owns, the output writer (`appendOutput` streams raw chunks, keeps a bounded tail and spills the
 * complete stream to a file), the screen every job exposes to readers
 * (`getScreenLines` returns the output after a headless terminal executed it), the outcome each settle accepts, the
 * idempotence of settling (a job that is unknown or already settled is refused without an event or
 * a counter change), the per-status counters, and the notification semantics (synchronous, once
 * per mutation, unsubscribe-able) including the isolation of a subscriber that throws.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";

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

/**
 * The job's screen once the emulator has executed everything written to it so far.
 *
 * Jobs stream raw VT instructions into a headless terminal, which parses queued writes on a later
 * tick; reading without flushing would see the previous screen.
 */
async function screenLines(manager: ShellManager, id: string): Promise<string[]> {
    const terminal = manager.getJob(id)!.terminal;
    await new Promise<void>((resolve) => terminal.write("", () => resolve()));

    return manager.getScreenLines(id);
}

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
            assert.equal(job.output.content, "");
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
            assert.equal(job.output.content, "line 1\n", "settling must keep the streamed output");
            assert.equal(job.exitCode, 0);
            assert.equal(job.startedAt, startedAt);
            assert.ok(job.finishedAt !== undefined && job.finishedAt >= job.startedAt);
            assert.equal(job.lastActivityAt, job.finishedAt, "the finish is the last activity");
            assert.equal(job.error, undefined);
        });

        it("records the outcome it is told without interpreting the exit code", () => {
            // Contract: classifying a process result is the runner's job. The manager stores a
            // completed outcome with a non-zero code and a failed outcome with one exactly as given.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            assert.equal(manager.settleJob("job-a", completed(3)), true);

            const completedJob = manager.getJob("job-a");
            assert.ok(completedJob);
            assert.equal(completedJob.status, "completed");
            assert.equal(completedJob.exitCode, 3);
            assert.equal(completedJob.error, undefined);

            startRunningJob(manager, { id: "job-b" });

            assert.equal(manager.settleJob("job-b", failed("Background shell exited with code 3", 3)), true);

            const failedJob = manager.getJob("job-b");
            assert.ok(failedJob);
            assert.equal(failedJob.status, "failed");
            assert.equal(failedJob.exitCode, 3);
            assert.equal(failedJob.error, "Background shell exited with code 3");
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
            assert.equal(job.output.content, "partial output", "a failure must not discard the streamed output");
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
            assert.equal(job.output.content, "before kill", "a kill must not discard the streamed output");
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

        it("settles the job and keeps later listeners running when an earlier listener throws", () => {
            // Desired contract: observers cannot veto a mutation. A throwing listener must not make
            // the settle fail, hide the event from later listeners, or move a counter twice.
            const cases = [
                {
                    outcome: completed(0),
                    status: "completed",
                    event: "job-completed",
                    stats: { runningCount: 0, completedCount: 1, failedCount: 0, killedCount: 0 },
                },
                {
                    outcome: failed("boom", 3),
                    status: "failed",
                    event: "job-failed",
                    stats: { runningCount: 0, completedCount: 0, failedCount: 1, killedCount: 0 },
                },
                {
                    outcome: killed("manual"),
                    status: "killed",
                    event: "job-killed",
                    stats: { runningCount: 0, completedCount: 0, failedCount: 0, killedCount: 1 },
                },
            ] as const;

            for (const { outcome, status, event, stats } of cases) {
                const manager = new ShellManager();
                const id = `${status}-job`;
                startRunningJob(manager, { id });
                const seen: string[] = [];
                manager.subscribe(() => {
                    throw new Error("observer boom");
                });
                manager.subscribe((received) => {
                    seen.push(received.type);
                });

                let settled = false;
                assert.doesNotThrow(() => {
                    settled = manager.settleJob(id, outcome);
                }, `a throwing listener must not fail the ${status} settle`);
                assert.equal(settled, true);

                const job = manager.getJob(id)!;
                assert.equal(job.status, status);
                assert.ok(job.finishedAt !== undefined);
                assert.equal(job.lastActivityAt, job.finishedAt);
                assert.deepEqual(seen, [event], `the later listener must still see ${event}`);
                assert.deepEqual(manager.getAllJobsStatusStat(), stats);
                assert.equal(manager.settleJob(id, completed(0)), false, "a second settle must stay refused");
                assert.deepEqual(manager.getAllJobsStatusStat(), stats, "the refused settle must not move a counter");
            }
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
            assert.equal(job.output.content, "chunk 1\nchunk 2\nchunk 3");
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

            assert.equal(manager.getJob("job-a")?.output.content, "kept");
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

        it("appends the chunk and keeps later listeners running when a listener throws", async () => {
            // Desired contract: the output write is committed before observers run, so an observer
            // failure must not make appendOutput throw or block the later listeners.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const seen: string[] = [];
            manager.subscribe(() => {
                throw new Error("observer boom");
            });
            manager.subscribe((event) => {
                seen.push(event.type);
            });

            assert.doesNotThrow(() => manager.appendOutput("job-a", "one\ntwo\n"));
            const job = manager.getJob("job-a")!;
            assert.equal(job.output.content, "one\ntwo\n");
            assert.equal(job.output.totalLines, 2);
            assert.equal(job.output.totalBytes, Buffer.byteLength("one\ntwo\n"));
            assert.deepEqual(seen, ["output-updated"], "the later listener must still see the event");
            assert.deepEqual(await screenLines(manager, "job-a"), ["one", "two"], "the emulator must receive the chunk");

            assert.doesNotThrow(() => manager.appendOutput("job-a", "three"));
            assert.equal(job.output.content, "one\ntwo\nthree", "later output must still be appendable");
        });

        it("rejects an unknown id and every settled job", () => {
            // Contract: appendOutput is the running-only writer, so a late chunk cannot corrupt a
            // settled job's final output - whichever outcome settled it.
            const manager = new ShellManager();
            assert.throws(() => manager.appendOutput("missing", "late"), /Unknown shell job: missing/);

            startRunningJob(manager, { id: "completed" });
            manager.appendOutput("completed", "final");
            manager.settleJob("completed", completed(0));
            startRunningJob(manager, { id: "failed" });
            manager.settleJob("failed", failed("boom"));
            startRunningJob(manager, { id: "killed" });
            manager.settleJob("killed", killed("timeout:1"));

            assert.throws(
                () => manager.appendOutput("completed", "late"),
                /Shell job "completed" is not running: completed/,
            );
            assert.throws(
                () => manager.appendOutput("failed", "late"),
                /Shell job "failed" is not running: failed/,
            );
            assert.throws(
                () => manager.appendOutput("killed", "late"),
                /Shell job "killed" is not running: killed/,
            );
            assert.equal(manager.getJob("completed")?.output.content, "final");
            assert.equal(manager.getJob("failed")?.output.content, "");
            assert.equal(manager.getJob("killed")?.output.content, "");
        });
    });

    describe("output retention", () => {
        /** Spill files created by the current test, removed afterwards. */
        const spillPaths: string[] = [];

        afterEach(() => {
            for (const path of spillPaths.splice(0)) {
                rmSync(path, { force: true });
            }
        });

        /** The job's spill file, tracked for cleanup. */
        function spillPath(manager: ShellManager, id: string): string {
            const path = manager.getJob(id)?.output.fullOutputPath;
            assert.ok(path, `expected job ${id} to have spilled its output`);
            spillPaths.push(path);
            return path;
        }

        /** A stream long enough to cross the line limit but far below the byte limit. */
        function longStream(lines: number): string {
            return Array.from({ length: lines }, (_, index) => `L${index}`).join("\n");
        }

        it("keeps a small output in memory without spilling", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            manager.appendOutput("job-a", "one\n");
            manager.appendOutput("job-a", "two\n");

            const job = manager.getJob("job-a")!;
            assert.equal(job.output.content, "one\ntwo\n");
            assert.equal(job.output.truncated, false);
            assert.equal(job.output.fullOutputPath, undefined);
        });

        it("concatenates chunks exactly as they arrive, across chunk boundaries", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            manager.appendOutput("job-a", "line 1");
            manager.appendOutput("job-a", "\nline ");
            manager.appendOutput("job-a", "2\nline 3");

            assert.equal(manager.getJob("job-a")!.output.content, "line 1\nline 2\nline 3");
        });

        it("counts totalBytes in UTF-8 bytes, not in string length", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const chunks = ["ascii\n", "中文\n", "🚀\n"];

            for (const chunk of chunks) {
                manager.appendOutput("job-a", chunk);
            }

            const job = manager.getJob("job-a")!;
            const full = chunks.join("");

            assert.equal(job.output.content, full);
            assert.equal(job.output.totalBytes, Buffer.byteLength(full));
            assert.notEqual(job.output.totalBytes, full.length, "multibyte chunks must differ from code-unit length");
        });

        it("counts totalLines as newlines, across chunks and without a trailing newline", () => {
            // Contract: the field is a newline counter, not a display line count - the last line of a
            // stream that does not end in "\n" is not counted.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            manager.appendOutput("job-a", "line 1\nline 2\n");
            assert.equal(manager.getJob("job-a")!.output.totalLines, 2, "one newline per terminated line");

            manager.appendOutput("job-a", "still line 2");
            assert.equal(manager.getJob("job-a")!.output.totalLines, 2, "a line split across chunks counts once");

            manager.appendOutput("job-a", "\nlast line without break");
            assert.equal(manager.getJob("job-a")!.output.totalLines, 3, "the unterminated last line is not counted");
        });

        it("spills on the chunk that first crosses pi's limits", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const head = longStream(DEFAULT_MAX_LINES);

            manager.appendOutput("job-a", head);
            assert.equal(manager.getJob("job-a")!.output.truncated, false, "exactly at the line limit is not truncated");
            assert.equal(manager.getJob("job-a")!.output.fullOutputPath, undefined, "no file before the limit is crossed");

            manager.appendOutput("job-a", "\noverflow");
            const job = manager.getJob("job-a")!;
            const path = spillPath(manager, "job-a");
            const full = `${head}\noverflow`;

            assert.equal(job.output.truncated, true);
            assert.equal(job.output.fullOutputPath, path, "the job keeps the file it created");
            assert.equal(readFileSync(path, "utf8"), full, "the spill file starts with everything appended so far");
            assert.equal(job.output.content, truncateTail(full).content, "the retained tail matches pi's truncation");
            assert.equal(job.output.totalLines, full.match(/\n/g)!.length);
            assert.equal(job.output.totalBytes, Buffer.byteLength(full));
        });

        it("appends every later chunk to the same file instead of spilling again", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const first = longStream(DEFAULT_MAX_LINES + 1);
            manager.appendOutput("job-a", first);
            const path = spillPath(manager, "job-a");

            manager.appendOutput("job-a", "\ntail 1");
            manager.appendOutput("job-a", "\ntail 2");

            const job = manager.getJob("job-a")!;
            const full = `${first}\ntail 1\ntail 2`;

            assert.equal(job.output.fullOutputPath, path, "the file must not be replaced");
            assert.equal(readFileSync(path, "utf8"), full, "the file must grow with every chunk");
            assert.equal(job.output.content, truncateTail(full).content, "memory keeps only the bounded tail");
            assert.ok(!job.output.content.includes("L0\n"), "the dropped head must not stay in memory");
        });

        it("retains exactly pi's tail truncation at the line limit", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const full = longStream(DEFAULT_MAX_LINES + 500);

            manager.appendOutput("job-a", full);

            const job = manager.getJob("job-a")!;
            const expected = truncateTail(full);
            spillPath(manager, "job-a");

            assert.equal(expected.truncatedBy, "lines", "guard: this stream must cross the line limit first");
            assert.equal(job.output.content, expected.content);
            assert.equal(job.output.content.split("\n").length, DEFAULT_MAX_LINES);
        });

        it("spills on the byte limit even when the line count stays far below the line limit", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            // 200 lines x 120 CJK characters: ~72KB of UTF-8 in only 200 lines.
            const full = Array.from({ length: 200 }, () => "中".repeat(120)).join("\n");
            assert.ok(full.split("\n").length < DEFAULT_MAX_LINES, "guard: the line limit must not be the trigger");

            manager.appendOutput("job-a", full);

            const job = manager.getJob("job-a")!;
            const expected = truncateTail(full);
            const path = spillPath(manager, "job-a");

            assert.equal(expected.truncatedBy, "bytes", "guard: the byte limit must be the trigger");
            assert.equal(job.output.truncated, true);
            assert.equal(job.output.content, expected.content);
            assert.equal(job.output.totalBytes, Buffer.byteLength(full));
            assert.equal(readFileSync(path, "utf8"), full);
        });

        it("writes a post-spill chunk to the file even when the retained tail does not change", () => {
            // Regression: once spilled, the file is the record - every chunk must reach it whether or
            // not truncateTail() would report a new truncation for that chunk.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", longStream(DEFAULT_MAX_LINES + 500));
            const path = spillPath(manager, "job-a");

            manager.appendOutput("job-a", "empty chunk ignored");
            const before = statSync(path).size;
            manager.appendOutput("job-a", "yz");

            assert.equal(statSync(path).size, before + 2, "every chunk must be appended verbatim");
            assert.ok(readFileSync(path, "utf8").endsWith("yz"));
        });

        it("returns the plain content when nothing was dropped", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "hello\nworld\n");

            assert.equal(manager.getJobOutput("job-a"), "hello\nworld\n");
        });

        it("returns the bounded tail behind a spill banner when output was truncated", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const full = longStream(DEFAULT_MAX_LINES + 500);
            manager.appendOutput("job-a", full);
            const path = spillPath(manager, "job-a");

            const reported = manager.getJobOutput("job-a");
            const lines = reported.split("\n");

            assert.equal(lines.at(0), `[Output truncated. Full output: ${path}]`);
            assert.equal(lines.at(1), `L${full.split("\n").length - DEFAULT_MAX_LINES}`, "the tail starts at the retained line");
            assert.equal(lines.at(-1), `L${full.split("\n").length - 1}`, "the newest line must reach the reader");
            assert.ok(!reported.includes("[object Object]"), "the structured output must be rendered, not stringified");
        });

        it("reports an empty string for a job that never received a chunk", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.settleJob("job-a", completed(0));

            assert.equal(manager.getJobOutput("job-a"), "");
            assert.equal(manager.getJob("job-a")!.output.fullOutputPath, undefined);
        });

        it("gives each spilled job its own file", () => {
            const manager = new ShellManager();
            const full = longStream(DEFAULT_MAX_LINES + 500);
            startRunningJob(manager, { id: "job-a" });
            startRunningJob(manager, { id: "job-b" });

            manager.appendOutput("job-a", full);
            manager.appendOutput("job-b", `${full}\nB`);

            const a = spillPath(manager, "job-a");
            const b = spillPath(manager, "job-b");

            assert.notEqual(a, b);
            assert.equal(readFileSync(a, "utf8"), full);
            assert.equal(readFileSync(b, "utf8"), `${full}\nB`);
        });

        it("leaves spill files on disk when the jobs are cleared", () => {
            // Contract: clearAllJobs() drops the jobs and disposes their emulators; it does not delete
            // the spill files a reader may still open.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", longStream(DEFAULT_MAX_LINES + 1));
            const path = spillPath(manager, "job-a");

            manager.clearAllJobs();

            assert.equal(existsSync(path), true, "clearing the jobs must not delete the spill file");
        });

        it("leaves the complete spill file untouched when the job settles", () => {
            // Contract: the spill file is the record of the whole stream. Settling only stamps the
            // outcome; it must not rewrite, truncate or replace the file, and a refused late chunk
            // must not reach it either.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const full = longStream(DEFAULT_MAX_LINES + 500);
            manager.appendOutput("job-a", full);
            const path = spillPath(manager, "job-a");
            const sizeBeforeSettle = statSync(path).size;

            assert.equal(manager.settleJob("job-a", completed(0)), true);

            const job = manager.getJob("job-a")!;
            assert.equal(existsSync(path), true, "settling must not remove the spill file");
            assert.equal(statSync(path).size, sizeBeforeSettle, "settling must not rewrite the file");
            assert.equal(readFileSync(path, "utf8"), full, "the file must still hold every byte");
            assert.equal(job.output.fullOutputPath, path);
            assert.equal(job.output.truncated, true);
            assert.equal(
                manager.getJobOutput("job-a"),
                `[Output truncated. Full output: ${path}]\n${truncateTail(full).content}`,
            );

            assert.throws(() => manager.appendOutput("job-a", "late\n"), /is not running/);
            assert.equal(statSync(path).size, sizeBeforeSettle, "a refused late chunk must not reach the file");
        });

        it("keeps interleaved post-spill writes in each job's own file", () => {
            // Contract: after both jobs spilled, alternating chunks must still land in the right
            // file, in order, with no cross-contamination between the two streams.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            startRunningJob(manager, { id: "job-b" });
            const headA = longStream(DEFAULT_MAX_LINES + 100);
            const headB = longStream(DEFAULT_MAX_LINES + 50);

            manager.appendOutput("job-a", headA);
            manager.appendOutput("job-b", headB);
            const pathA = spillPath(manager, "job-a");
            const pathB = spillPath(manager, "job-b");
            assert.notEqual(pathA, pathB, "each job must own its file");

            const aChunks = ["a-1\n", "a-2\n", "a-3\n"];
            const bChunks = ["b-1\n", "b-2\n", "b-3\n"];
            for (let index = 0; index < aChunks.length; index++) {
                manager.appendOutput("job-a", aChunks[index]!);
                manager.appendOutput("job-b", bChunks[index]!);
            }

            const fullA = headA + aChunks.join("");
            const fullB = headB + bChunks.join("");
            assert.equal(readFileSync(pathA, "utf8"), fullA);
            assert.equal(readFileSync(pathB, "utf8"), fullB);
            assert.ok(!readFileSync(pathA, "utf8").includes("b-1"), "A's file must not receive B's chunks");
            assert.ok(!readFileSync(pathB, "utf8").includes("a-1"), "B's file must not receive A's chunks");
            assert.ok(manager.getJobOutput("job-a").includes("a-3"), "A's newest chunk must stay readable");
            assert.ok(manager.getJobOutput("job-b").includes("b-3"), "B's newest chunk must stay readable");
            assert.equal(manager.getJob("job-a")!.output.totalBytes, Buffer.byteLength(fullA));
            assert.equal(manager.getJob("job-b")!.output.totalBytes, Buffer.byteLength(fullB));
            assert.equal(manager.getJob("job-a")!.output.totalLines, (fullA.match(/\n/g) ?? []).length);
            assert.equal(manager.getJob("job-b")!.output.totalLines, (fullB.match(/\n/g) ?? []).length);
        });
    });

    describe("getScreenLines", () => {
        it("returns the executed screen instead of the raw text", async () => {
            // Contract: readers get the result of the VT instructions - the redraws collapsed, the
            // erased text gone - and never the control bytes themselves.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "\x1b[32mprogress 1%\x1b[0m\rprogress 50%\r\x1b[Kprogress 100%\n");

            assert.deepEqual(await screenLines(manager, "job-a"), ["progress 100%"]);
        });

        it("has no lines before anything was written", async () => {
            // Contract: the emulator's fixed height must not leak into readers as blank lines.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            assert.deepEqual(await screenLines(manager, "job-a"), []);
        });

        it("keeps plain lines in order and adds no line for a trailing newline", async () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "hello world\n");
            manager.appendOutput("job-a", "second\nthird\n");

            assert.deepEqual(await screenLines(manager, "job-a"), ["hello world", "second", "third"]);
        });

        it("collapses carriage-return redraws into the current line", async () => {
            // The tqdm shape: one line rewritten in place. Nothing may be left over from the longer
            // earlier redraws and nothing may stack up as separate lines.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "progress 1%\rprogress 50%\rprogress 100%");

            assert.deepEqual(await screenLines(manager, "job-a"), ["progress 100%"]);
        });

        it("applies erase-line and keeps a partial last line", async () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "downloading 100%\x1b[2K\rdone");

            assert.deepEqual(await screenLines(manager, "job-a"), ["done"]);
        });

        it("applies cursor movement to the screen", async () => {
            // Cursor-left overwrites in place, cursor-up returns to the row above at the same column,
            // and cursor-right moves over the cells the earlier text never filled.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "abcdef\x1b[3DXY\nsecond\x1b[A!\x1b[7Cend");

            assert.deepEqual(await screenLines(manager, "job-a"), ["abcXYf!       end", "second"]);
        });

        it("strips SGR styling and window-title sequences", async () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "\x1b[31mred\x1b[0m plain \x1b[1;44mbold on blue\x1b[0m\n");
            manager.appendOutput("job-a", "\x1b]0;window title\x07after title\n");

            assert.deepEqual(
                await screenLines(manager, "job-a"),
                ["red plain bold on blue", "after title"],
            );
        });

        it("carries the parser across chunks that split a sequence", async () => {
            // Chunk boundaries are a transport artefact: a CSI split after `ESC [` and a carriage
            // return split from the text it overwrites must end up like one write.
            const chunks = ["\x1b[", "31mred", "%\rprog", "ress 2%\n"];

            const split = new ShellManager();
            startRunningJob(split, { id: "job-a" });
            for (const chunk of chunks) {
                split.appendOutput("job-a", chunk);
            }

            const single = new ShellManager();
            startRunningJob(single, { id: "job-b" });
            single.appendOutput("job-b", chunks.join(""));

            assert.deepEqual(await screenLines(split, "job-a"), ["progress 2%"]);
            assert.deepEqual(await screenLines(split, "job-a"), await screenLines(single, "job-b"));
        });

        it("keeps wide characters and emoji intact", async () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "進捗: 50%\r進捗: 100% ✓\nemoji: 🚀 done\n");

            assert.deepEqual(
                await screenLines(manager, "job-a"),
                ["進捗: 100% ✓", "emoji: 🚀 done"],
            );
        });

        it("rejoins wrapped rows but keeps explicit line breaks", async () => {
            // Contract: `isWrapped` marks the rows the emulator produced itself, so a line wider than
            // the screen is one logical line while a `\n` stays a line of its own. A wide character
            // that cannot fit the last column moves to the next row and must survive the join.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const wide = "x".repeat(400);
            const straddling = "s".repeat(119) + "漢" + "end";
            manager.appendOutput("job-a", `${wide}\n${straddling}\nnext\n`);

            assert.deepEqual(await screenLines(manager, "job-a"), [wide, straddling, "next"]);
        });

        it("drops the blank rows the screen pads itself with but keeps blank output lines", async () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "first\n\nsecond\n\n");

            assert.deepEqual(await screenLines(manager, "job-a"), ["first", "", "second"]);
        });

        it("keeps the raw stream on the screen no matter what the retained tail drops", async () => {
            // Contract: the emulator executes every chunk as it arrives, so the screen is not a replay
            // of `output.content` - the screen keeps lines the bounded tail has already dropped.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const total = 5500;
            manager.appendOutput("job-a", Array.from({ length: total }, (_, index) => `L${index}`).join("\n"));

            const lines = await screenLines(manager, "job-a");
            const job = manager.getJob("job-a")!;

            assert.equal(lines.at(-1), `L${total - 1}`);
            assert.ok(
                lines.length > job.output.content.split("\n").length,
                "the screen must reach lines the retained tail dropped",
            );
        });

        it("routes every chunk to its own job's screen", async () => {
            // Contract: each job owns its emulator, so interleaved streams never mix.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            startRunningJob(manager, { id: "job-b" });

            manager.appendOutput("job-a", "AAA");
            manager.appendOutput("job-b", "BBB");
            manager.appendOutput("job-a", "-more\n");
            manager.appendOutput("job-b", "-more\n");

            assert.deepEqual(await screenLines(manager, "job-a"), ["AAA-more"]);
            assert.deepEqual(await screenLines(manager, "job-b"), ["BBB-more"]);
        });

        it("keeps the screen of a settled job readable", async () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "suite 1 ok\n");

            assert.equal(manager.settleJob("job-a", completed(3)), true);

            assert.deepEqual(await screenLines(manager, "job-a"), ["suite 1 ok"]);
            assert.throws(() => manager.appendOutput("job-a", "late"), /is not running/);
        });

        it("bounds the screen history and the retained tail while the complete stream is spilled", async () => {
            // Contract: two independent limits - the emulator keeps a bounded window (5000 scrollback
            // lines plus its rows), while `output.content` keeps only pi's tail limits and the whole
            // stream goes to `fullOutputPath`.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const total = 5500;
            const full = Array.from({ length: total }, (_, index) => `L${index}`).join("\n");
            manager.appendOutput("job-a", full);

            const lines = await screenLines(manager, "job-a");
            const job = manager.getJob("job-a")!;

            assert.equal(lines.at(-1), `L${total - 1}`, "the newest line must be kept");
            assert.ok(lines.length < total, `the screen must drop its oldest lines, kept ${lines.length}`);
            assert.ok(
                lines.length > DEFAULT_MAX_LINES && lines.length <= DEFAULT_MAX_LINES + 50,
                `the screen must keep its bounded scrollback plus its rows, kept ${lines.length}`,
            );
            assert.notEqual(lines.at(0), "L0", "the dropped lines must be the oldest ones");

            assert.equal(job.output.truncated, true);
            assert.equal(job.output.content.split("\n").length, DEFAULT_MAX_LINES, "the retained tail is bounded");
            assert.equal(job.output.totalLines, total - 1, "the totals still count the whole stream");
            assert.equal(readFileSync(job.output.fullOutputPath!, "utf8"), full, "the spill file holds every byte");

            rmSync(job.output.fullOutputPath!, { force: true });
        });

        it("keeps chunk order when output arrives in many small writes", async () => {
            // xterm parses queued writes asynchronously; the queue must preserve the order.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            for (let index = 0; index < 500; index++) {
                manager.appendOutput("job-a", `line ${index}\n`);
            }

            const lines = await screenLines(manager, "job-a");

            assert.equal(lines.length, 500);
            assert.equal(lines.at(0), "line 0");
            assert.equal(lines.at(-1), "line 499");
        });

        it("rejects an unknown id", () => {
            assert.throws(() => new ShellManager().getScreenLines("missing"), /Unknown shell job: missing/);
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
            job.output.content = "written through the reference";

            assert.equal(manager.getAllJobsList().at(0)?.output.content, "written through the reference");
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

        it("isolates a throwing listener so later listeners still receive every event", () => {
            // Desired contract (regression): one failing observer must not abort emit(). The shell
            // mutation completes, and the remaining listeners see started, output and settled events
            // in registration order.
            const manager = new ShellManager();
            const seen: string[] = [];
            manager.subscribe(() => {
                throw new Error("listener boom");
            });
            manager.subscribe((event) => {
                seen.push(`B:${event.type}`);
            });
            manager.subscribe((event) => {
                seen.push(`C:${event.type}`);
            });

            assert.doesNotThrow(() => startRunningJob(manager, { id: "job-a" }));
            assert.doesNotThrow(() => manager.appendOutput("job-a", "chunk\n"));
            assert.doesNotThrow(() => manager.settleJob("job-a", completed(0)));

            assert.deepEqual(seen, [
                "B:job-started",
                "C:job-started",
                "B:output-updated",
                "C:output-updated",
                "B:job-completed",
                "C:job-completed",
            ], "every listener after the throwing one must receive every event");
            const job = manager.getJob("job-a")!;
            assert.equal(job.status, "completed");
            assert.equal(job.output.content, "chunk\n");
            assert.equal(job.exitCode, 0);
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 1,
                failedCount: 0,
                killedCount: 0,
            });
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
