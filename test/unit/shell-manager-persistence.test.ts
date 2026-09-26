/**
 * Persistence contract of `ShellManager`.
 *
 * The manager is the only owner of shell job state, and the session log is its only durable store:
 * `clearAllJobs(pi)` freezes the current jobs into one `lune-shell-view-status` custom entry, and
 * `restoreShellManager(ctx)` rebuilds jobs from the newest such entry on the active branch. These
 * tests pin the two halves separately - the payload and the teardown a clear performs, and the
 * branch-sensitive, side-effect-free rebuild a restore performs - because every session lifecycle
 * (`/reload`, `/quit` + resume, `/new`, `/fork`, `/tree`) is a different composition of exactly
 * these two calls. Cross-session end-to-end behaviour lives in
 * `test/integration/session-persistence.test.ts`.
 *
 * The branch a snapshot is written to is chosen by pi, not by the manager: `pi.appendEntry` appends
 * under the session's current leaf. The tests therefore assert *what* is written and *when* (once,
 * after running jobs are killed, before the manager is emptied), not which leaf pi picked.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { describe, it } from "node:test";

import { DEFAULT_MAX_LINES, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    ShellManager,
    type ShellJobOutcome,
} from "../../src/shell/shell-manager.ts";
import {
    FakeSessionLog,
    createFakeContext,
} from "../harness.ts";
import {
    SHELL_STATUS_ENTRY,
    appendRawShellStatus,
    appendShellStatus,
    newSessionLog,
    recordingPi,
    type ShellStatusSnapshot,
} from "../helpers/session-log.ts";

const completed = (exitCode?: number): ShellJobOutcome => ({ type: "completed", exitCode });
const failed = (error: string, exitCode?: number): ShellJobOutcome => ({ type: "failed", error, exitCode });
const killed = (error?: string): ShellJobOutcome => ({ type: "killed", error });

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

/** A manager holding one job of each status, in insertion order. */
function managerWithEveryStatus(): {
    manager: ShellManager;
    controllers: {
        killed: AbortController;
        completed: AbortController;
        failed: AbortController;
        running: AbortController;
    };
} {
    const manager = new ShellManager();
    const controllers = {
        killed: startRunningJob(manager, { id: "killed", command: "kill-me" }),
        completed: startRunningJob(manager, { id: "completed", command: "echo done" }),
        failed: startRunningJob(manager, { id: "failed", command: "exit 3" }),
        running: startRunningJob(manager, { id: "running", command: "sleep 30" }),
    };
    manager.settleJob("completed", completed(0));
    manager.settleJob("failed", failed("Command exited with code 3", 3));
    manager.settleJob("killed", killed("timeout:1"));
    return { manager, controllers };
}

/** Flush a job's emulator so its screen reflects every write queued so far. */
async function screenLines(manager: ShellManager, id: string): Promise<string[]> {
    const terminal = manager.getJob(id)!.terminal;
    await new Promise<void>((resolve) => terminal.write("", () => resolve()));
    return manager.getScreenLines(id);
}

/** A context whose active branch ends at `log`'s leaf. */
function contextFor(log: FakeSessionLog, cwd = "/work"): ExtensionContext {
    return createFakeContext(cwd, { sessionLog: log });
}

describe("ShellManager persistence", () => {
    describe("clearAllJobs(pi)", () => {
        it("kills running jobs before writing the snapshot, so the payload records them as killed", () => {
            // Contract: the snapshot must describe what actually happened to the session's shells.
            // A running job is aborted and settled as killed first; without that ordering the entry
            // would claim a dead process was still running.
            const { manager, controllers } = managerWithEveryStatus();
            const { pi, calls } = recordingPi();

            manager.clearAllJobs(pi);

            assert.equal(controllers.running.signal.aborted, true, "teardown must abort the live process tree");
            const snapshot = calls[0]!.data as ShellStatusSnapshot;
            const byId = new Map(snapshot.jobs.map((job) => [job.id, job]));
            assert.equal(byId.get("running")!.status, "killed");
            assert.equal(byId.get("running")!.error, "pi session shutdown");
            assert.deepEqual(
                snapshot.stats,
                { runningCount: 0, completedCount: 1, failedCount: 1, killedCount: 2 },
                "the killed running job and the already-killed job both count as killed",
            );
        });

        it("leaves settled jobs exactly as they were", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "completed" });
            manager.settleJob("completed", completed(7));
            startRunningJob(manager, { id: "failed" });
            manager.settleJob("failed", failed("boom", 2));
            const { pi, calls } = recordingPi();

            manager.clearAllJobs(pi);

            const snapshot = calls[0]!.data as ShellStatusSnapshot;
            const byId = new Map(snapshot.jobs.map((job) => [job.id, job]));
            assert.equal(byId.get("completed")!.status, "completed");
            assert.equal(byId.get("completed")!.exitCode, 7);
            assert.equal(byId.get("failed")!.status, "failed");
            assert.equal(byId.get("failed")!.error, "boom");
            assert.equal(byId.get("failed")!.exitCode, 2);
        });

        it("writes one full snapshot carrying the job fields restore needs", () => {
            // Contract: command, cwd, timestamps, outcome, output and the output totals are the fields
            // a later session rebuilds a job from; a field dropped here is gone for the resumed session.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a", command: "npm test", cwd: "/work/app" });
            manager.appendOutput("job-a", "suite 1 ok\n");
            manager.settleJob("job-a", completed(0));
            const job = manager.getJob("job-a")!;
            const { pi, calls } = recordingPi();

            manager.clearAllJobs(pi);

            assert.equal(calls.length, 1, "a clear must write exactly one snapshot");
            assert.equal(calls[0]!.customType, SHELL_STATUS_ENTRY);
            const snapshot = calls[0]!.data as ShellStatusSnapshot;
            assert.deepEqual(snapshot.stats, {
                runningCount: 0,
                completedCount: 1,
                failedCount: 0,
                killedCount: 0,
            });

            const saved = snapshot.jobs[0]!;
            assert.equal(saved.id, "job-a");
            assert.equal(saved.command, "npm test");
            assert.equal(saved.cwd, "/work/app");
            assert.equal(saved.status, "completed");
            assert.equal(saved.startedAt, job.startedAt);
            assert.equal(saved.finishedAt, job.finishedAt);
            assert.equal(saved.lastActivityAt, job.lastActivityAt);
            assert.equal(saved.exitCode, 0);
            assert.deepEqual(saved.output, {
                content: "suite 1 ok\n",
                truncated: false,
                totalLines: 1,
                totalBytes: Buffer.byteLength("suite 1 ok\n"),
                fullOutputPath: undefined,
            });
            for (const key of ["terminal", "controller"]) {
                assert.equal(key in saved, false, `the snapshot must not carry ${key}`);
            }
        });

        it("preserves a spilled job's output fields, including fullOutputPath", () => {
            // Contract: the spill file belongs to the reader, not to the session; restore must keep
            // pointing at it instead of dropping the tail's provenance.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "spilled" });
            const lines = DEFAULT_MAX_LINES + 500;
            manager.appendOutput("spilled", Array.from({ length: lines }, (_, index) => `L${index}`).join("\n"));
            const spilled = manager.getJob("spilled")!;
            const spillPath = spilled.output.fullOutputPath!;
            const { pi, calls } = recordingPi();

            try {
                manager.clearAllJobs(pi);

                const saved = (calls[0]!.data as ShellStatusSnapshot).jobs[0]!;
                assert.equal(saved.output.truncated, true);
                assert.equal(saved.output.content, spilled.output.content);
                assert.equal(saved.output.fullOutputPath, spillPath);
                assert.equal(saved.output.totalLines, spilled.output.totalLines);
                assert.equal(saved.output.totalBytes, spilled.output.totalBytes);
            } finally {
                rmSync(spillPath, { force: true });
            }
        });

        it("empties the manager and its counters after the snapshot was written", () => {
            const { manager } = managerWithEveryStatus();
            const { pi, calls } = recordingPi();

            manager.clearAllJobs(pi);

            assert.equal(calls.length, 1, "the snapshot must be written before the jobs are dropped");
            assert.deepEqual(manager.getAllJobsList(), []);
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            });
        });

        it("disposes the terminals of the jobs it drops", async () => {
            // Contract: a disposed emulator stops rendering; leaking one keeps its buffers and
            // emitters alive for the whole pi process.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            manager.appendOutput("job-a", "old screen\n");
            const terminal = manager.getJob("job-a")!.terminal;
            assert.deepEqual(await screenLines(manager, "job-a"), ["old screen"]);

            manager.clearAllJobs();

            // A disposed xterm terminal drops writes instead of rendering them.
            terminal.write("late write\n");
            await new Promise<void>((resolve) => terminal.write("", () => resolve()));
            const buffer = terminal.buffer.active;
            const line = buffer.getLine(0);
            assert.equal(line?.translateToString(true), "old screen", "the disposed screen must not accept late writes");
            assert.deepEqual(manager.getAllJobsList(), []);
        });

        it("settles a job that was already killed during the clear exactly once", () => {
            // Contract: the clear kills every running job itself; the detached execution's own settle
            // (abort rejection) arrives later and must be a no-op instead of double-counting.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const { pi } = recordingPi();

            manager.clearAllJobs(pi);

            assert.equal(manager.settleJob("job-a", killed("aborted")), false);
            assert.equal(manager.settleJob("job-a", completed(0)), false);
        });

        it("still clears without a pi session and writes nothing", () => {
            // Contract: session_start calls clearAllJobs() without pi to drop whatever module state
            // survived an extension reload; that path must not require an append target.
            const manager = new ShellManager();
            const controller = startRunningJob(manager, { id: "job-a" });

            manager.clearAllJobs();

            assert.equal(controller.signal.aborted, true);
            assert.deepEqual(manager.getAllJobsList(), []);
        });

        it("appends successive snapshots in order, so the newest branch state wins", () => {
            // Contract: restore picks the newest entry on the branch. Two teardowns in one session
            // therefore leave the second snapshot as the one a later session rebuilds from.
            const log = newSessionLog();
            const manager = new ShellManager();
            const first = startRunningJob(manager, { id: "first" });
            void first;
            appendShellStatus(manager, log);
            startRunningJob(manager, { id: "second" });
            appendShellStatus(manager, log);

            const entries = log.entries().filter((entry) => entry.customType === SHELL_STATUS_ENTRY);
            assert.equal(entries.length, 2);
            const newest = entries[1]!.data as ShellStatusSnapshot;
            assert.deepEqual(newest.jobs.map((job) => job.id), ["second"]);
        });

        it("emits exactly one cleared event per call", () => {
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });
            const events: string[] = [];
            manager.subscribe((event) => {
                events.push(event.type);
            });
            const { pi } = recordingPi();

            manager.clearAllJobs(pi);

            assert.deepEqual(events, ["job-killed", "jobs-cleared"], "the kill of a running job is visible too");
        });
    });

    describe("restoreShellManager(ctx)", () => {
        it("restores the newest snapshot on the active branch", () => {
            // Contract: only the latest snapshot describes the current state; older ones are history
            // from this same branch and must not merge their jobs back in.
            const log = newSessionLog();
            const older = new ShellManager();
            startRunningJob(older, { id: "older-job" });
            appendShellStatus(older, log);
            const newer = new ShellManager();
            startRunningJob(newer, { id: "newer-job" });
            appendShellStatus(newer, log);
            const manager = new ShellManager();

            manager.restoreShellManager(contextFor(log));

            assert.deepEqual(manager.getAllJobsList().map((job) => job.id), ["newer-job"]);
        });

        it("rebuilds every job field from the snapshot", () => {
            const frozenAt = 1_700_000_000_000;
            const snapshot: ShellStatusSnapshot = {
                jobs: [
                    {
                        id: "job-a",
                        command: "npm test",
                        cwd: "/work/app",
                        status: "failed",
                        startedAt: frozenAt,
                        finishedAt: frozenAt + 5000,
                        lastActivityAt: frozenAt + 5000,
                        exitCode: 3,
                        error: "Command exited with code 3",
                        output: {
                            content: "suite 1 ok\nsuite 2 failed\n",
                            truncated: false,
                            totalLines: 2,
                            totalBytes: Buffer.byteLength("suite 1 ok\nsuite 2 failed\n"),
                        },
                    },
                ],
                stats: { runningCount: 0, completedCount: 0, failedCount: 1, killedCount: 0 },
            };
            const log = newSessionLog();
            appendRawShellStatus(log, snapshot);
            const manager = new ShellManager();

            manager.restoreShellManager(contextFor(log));

            const job = manager.getJob("job-a")!;
            assert.equal(job.command, "npm test");
            assert.equal(job.cwd, "/work/app");
            assert.equal(job.status, "failed");
            assert.equal(job.startedAt, frozenAt);
            assert.equal(job.finishedAt, frozenAt + 5000);
            assert.equal(job.lastActivityAt, frozenAt + 5000);
            assert.equal(job.exitCode, 3);
            assert.equal(job.error, "Command exited with code 3");
            assert.equal(job.output.content, "suite 1 ok\nsuite 2 failed\n");
            assert.equal(job.output.truncated, false);
            assert.equal(job.output.totalLines, 2);
            assert.equal(job.output.totalBytes, Buffer.byteLength("suite 1 ok\nsuite 2 failed\n"));
            assert.equal(job.output.fullOutputPath, undefined);
        });

        it("restores the stats exactly as the snapshot recorded them", () => {
            // Contract: the dock renders counters directly from the snapshot, so restore must not
            // recompute them from the job list - a snapshot can describe counters no longer derivable.
            const log = newSessionLog();
            const writer = new ShellManager();
            startRunningJob(writer, { id: "job-a" });
            writer.appendOutput("job-a", "streamed\n");
            const written = appendShellStatus(writer, log);
            written.stats.completedCount = 41;
            written.stats.killedCount = 2;

            const manager = new ShellManager();
            manager.restoreShellManager(contextFor(log));

            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 41,
                failedCount: 0,
                killedCount: 2,
            });
        });

        it("keeps a persisted job's output readable and its spill path intact", () => {
            const log = newSessionLog();
            const writer = new ShellManager();
            startRunningJob(writer, { id: "spilled" });
            writer.appendOutput(
                "spilled",
                Array.from({ length: DEFAULT_MAX_LINES + 10 }, (_, index) => `L${index}`).join("\n"),
            );
            const path = writer.getJob("spilled")!.output.fullOutputPath;
            const output = writer.getJob("spilled")!.output.content;
            appendShellStatus(writer, log);
            writer.clearAllJobs();

            const manager = new ShellManager();
            manager.restoreShellManager(contextFor(log));

            const restored = manager.getJob("spilled")!;
            assert.equal(restored.output.content, output);
            assert.equal(restored.output.truncated, true);
            assert.equal(restored.output.fullOutputPath, path);
            assert.ok(manager.getJobOutput("spilled").startsWith(`[Output truncated. Full output: ${path}]\n`));
        });

        it("restores a truncated job's full-output metadata without spilling again", () => {
            // Contract: the truncation provenance (flag, totals and the file the complete stream
            // went to) survives the round trip. Restore must not re-truncate, re-spill or try to
            // rebuild the dropped bytes from the bounded tail.
            const log = newSessionLog();
            const writer = new ShellManager();
            startRunningJob(writer, { id: "spilled" });
            const full = Array.from({ length: DEFAULT_MAX_LINES + 500 }, (_, index) => `L${index}`).join("\n");
            writer.appendOutput("spilled", full);
            const written = writer.getJob("spilled")!;
            const expected = {
                truncated: written.output.truncated,
                totalLines: written.output.totalLines,
                totalBytes: written.output.totalBytes,
                fullOutputPath: written.output.fullOutputPath,
                content: written.output.content,
            };
            assert.equal(expected.truncated, true, "guard: the stream must have spilled");
            const snapshot = appendShellStatus(writer, log);

            assert.deepEqual(snapshot.jobs[0]!.output, expected, "the snapshot must carry the truncation metadata");

            const manager = new ShellManager();
            manager.restoreShellManager(contextFor(log));
            const restored = manager.getJob("spilled")!;

            try {
                assert.equal(restored.output.truncated, true);
                assert.equal(restored.output.totalLines, expected.totalLines);
                assert.equal(restored.output.totalBytes, expected.totalBytes);
                assert.equal(restored.output.fullOutputPath, expected.fullOutputPath);
                assert.equal(restored.output.content, expected.content);
                assert.equal(
                    readFileSync(expected.fullOutputPath!, "utf8"),
                    full,
                    "the original spill file must stay the record",
                );
                assert.throws(
                    () => manager.appendOutput("spilled", "late\n"),
                    /is not running/,
                    "a restored settled job cannot spill a new file",
                );
            } finally {
                rmSync(expected.fullOutputPath!, { force: true });
            }
        });

        it("gives every restored job a fresh terminal and replays its output", async () => {
            // Contract: the terminal is a renderer, not durable state; restore must build a new one per
            // job so `/shell` and `background_shell` can show the persisted output immediately.
            const log = newSessionLog();
            const writer = new ShellManager();
            startRunningJob(writer, { id: "job-a" });
            writer.appendOutput("job-a", "hello\nworld\n");
            const originalTerminal = writer.getJob("job-a")!.terminal;
            appendShellStatus(writer, log);

            const manager = new ShellManager();
            manager.restoreShellManager(contextFor(log));

            const restored = manager.getJob("job-a")!;
            assert.notEqual(restored.terminal, originalTerminal, "the emulator belongs to the old session");
            assert.deepEqual(await screenLines(manager, "job-a"), ["hello", "world"]);
        });

        it("rebuilds a restored job's screen deterministically from the retained output", async () => {
            // Contract: the restored emulator executes the persisted text, so the screen after restore
            // is exactly the screen of replaying that text into a fresh terminal - plain lines, CR
            // redraws, SGR colour and erase-line all included.
            const log = newSessionLog();
            const writer = new ShellManager();
            startRunningJob(writer, { id: "vt-job" });
            const stream =
                "plain line\n" +
                "\x1b[32mprogress 10%\x1b[0m\rprogress 100%\n" +
                "erase me\x1b[2K\rdone\n" +
                "\x1b[1;34mblue\x1b[0m end\n";
            writer.appendOutput("vt-job", stream);
            assert.deepEqual(await screenLines(writer, "vt-job"), [
                "plain line",
                "progress 100%",
                "done",
                "blue end",
            ]);
            const retained = writer.getJob("vt-job")!.output.content;
            appendShellStatus(writer, log);

            const manager = new ShellManager();
            manager.restoreShellManager(contextFor(log));
            const restored = await screenLines(manager, "vt-job");

            const replay = new ShellManager();
            startRunningJob(replay, { id: "replay" });
            replay.appendOutput("replay", retained);
            const replayed = await screenLines(replay, "replay");

            assert.deepEqual(restored, replayed, "restore must equal a fresh replay of the retained text");
            assert.deepEqual(restored, ["plain line", "progress 100%", "done", "blue end"]);
        });

        it("rebuilds only the retained tail, never screen history the bounded tail already dropped", async () => {
            // Contract limit: persistence stores the bounded tail, not the emulator's scrollback. A
            // restored job can therefore show only what the retained output still holds; screen lines
            // that left the tail before the snapshot must stay gone.
            const log = newSessionLog();
            const writer = new ShellManager();
            startRunningJob(writer, { id: "history-job" });
            const total = 6000;
            writer.appendOutput("history-job", Array.from({ length: total }, (_, index) => `L${index}`).join("\n"));
            const retained = writer.getJob("history-job")!.output.content;
            assert.ok(retained.includes("L4000"), "guard: the retained tail must have dropped the head");
            const originalScreen = await screenLines(writer, "history-job");

            appendShellStatus(writer, log);
            const manager = new ShellManager();
            manager.restoreShellManager(contextFor(log));
            const restoredScreen = await screenLines(manager, "history-job");

            const replay = new ShellManager();
            startRunningJob(replay, { id: "replay" });
            replay.appendOutput("replay", retained);
            const replayedScreen = await screenLines(replay, "replay");

            assert.deepEqual(restoredScreen, replayedScreen, "the restored screen must be the replay of the retained text");
            assert.notDeepEqual(restoredScreen, originalScreen, "the dropped screen history must not be reconstructed");
            assert.ok(!restoredScreen.includes("L0"), "the dropped head must not reappear");
        });

        it("gives every restored job a new, un-aborted controller", () => {
            // Contract: a restored job is inert state. It must get a usable controller of its own and
            // must not reuse (or fire) anything from the session that persisted it.
            const log = newSessionLog();
            const writer = new ShellManager();
            const original = startRunningJob(writer, { id: "job-a" });
            const snapshot = appendShellStatus(writer, log);
            assert.equal(snapshot.jobs[0]!.status, "killed");

            const manager = new ShellManager();
            manager.restoreShellManager(contextFor(log));

            const controller = manager.getJob("job-a")!.controller;
            assert.ok(controller instanceof AbortController);
            assert.notEqual(controller, original);
            assert.equal(controller.signal.aborted, false);
            assert.equal(original.signal.aborted, true, "the persisted job was killed when it was dropped");
        });

        it("restores every job of the snapshot, in order", () => {
            const log = newSessionLog();
            const writer = new ShellManager();
            startRunningJob(writer, { id: "a" });
            writer.settleJob("a", completed(0));
            startRunningJob(writer, { id: "b" });
            writer.settleJob("b", failed("boom"));
            startRunningJob(writer, { id: "c" });
            appendShellStatus(writer, log);

            const manager = new ShellManager();
            manager.restoreShellManager(contextFor(log));

            assert.deepEqual(manager.getAllJobsList().map((job) => job.id), ["a", "b", "c"]);
            // The third job was still running when the session recorded the snapshot, which kills it.
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 1,
                failedCount: 1,
                killedCount: 1,
            });
        });

        it("leaves the manager empty when the branch has no snapshot", () => {
            const log = newSessionLog();
            const context = contextFor(log);
            log.appendMessage("m1");
            log.appendMessage("m2");
            const manager = new ShellManager();

            manager.restoreShellManager(context);

            assert.deepEqual(manager.getAllJobsList(), []);
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            });
        });

        it("does not disturb a manager that already holds jobs", () => {
            // Contract: restore only adds the branch's snapshot. It never empties first - that is
            // clearAllJobs' job - so a snapshotless branch leaves the current state alone.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "live" });
            const log = newSessionLog();
            log.appendMessage("m1");

            manager.restoreShellManager(contextFor(log));

            assert.deepEqual(manager.getAllJobsList().map((job) => job.id), ["live"]);
        });

        it("reads only the active branch, never a sibling branch", () => {
            // Contract: this is the branch-selection rule `/tree`, `/resume` and `/fork` rely on.
            // Sibling branches are alternative histories; their snapshots must never leak into the
            // branch the session manager reports.
            const log = newSessionLog();
            const rootId = log.appendMessage("root").id;

            // Branch A: one completed job and two snapshots, so an implementation that flattened the
            // branch instead of finding its newest entry would still differ.
            const branchA = new ShellManager();
            startRunningJob(branchA, { id: "A1", command: "echo a" });
            branchA.settleJob("A1", completed(0));
            appendShellStatus(branchA, log);
            startRunningJob(branchA, { id: "A2", command: "sleep 30" });
            appendShellStatus(branchA, log);
            const leafA = log.leafId!;

            // Branch B forks from the root with a single failed job of its own.
            log.setLeaf(rootId);
            const branchB = new ShellManager();
            startRunningJob(branchB, { id: "B1", command: "exit 1" });
            branchB.settleJob("B1", failed("Command exited with code 1", 1));
            appendShellStatus(branchB, log);
            const leafB = log.leafId!;

            const manager = new ShellManager();
            log.setLeaf(leafA);
            manager.restoreShellManager(contextFor(log));

            assert.deepEqual(
                manager.getAllJobsList().map((job) => job.id),
                ["A2"],
                "the newest snapshot on branch A must win and B's job must never appear",
            );
            assert.equal(manager.getJob("A1"), undefined, "the older snapshot on the same branch is history");

            const second = new ShellManager();
            log.setLeaf(leafB);
            second.restoreShellManager(contextFor(log));
            assert.deepEqual(second.getAllJobsList().map((job) => job.id), ["B1"]);
            assert.equal(second.getJob("A2"), undefined);
        });

        it("is idempotent for the same branch", () => {
            // Contract: a session_start after a reload restores the same snapshot again; the manager
            // must end up in the same state rather than with duplicated jobs or counters.
            const log = newSessionLog();
            const writer = new ShellManager();
            startRunningJob(writer, { id: "job-a" });
            writer.settleJob("job-a", completed(0));
            appendShellStatus(writer, log);
            const manager = new ShellManager();
            const context = contextFor(log);

            manager.restoreShellManager(context);
            manager.restoreShellManager(context);

            assert.deepEqual(manager.getAllJobsList().map((job) => job.id), ["job-a"]);
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 1,
                failedCount: 0,
                killedCount: 0,
            });
        });

        it("takes the stats of the snapshot it restored, not of the older one", () => {
            // Contract: two snapshots on one branch describe two different states; mixing their
            // counters would show a dock that does not match the restored jobs.
            const log = newSessionLog();
            const first = new ShellManager();
            startRunningJob(first, { id: "first" });
            appendShellStatus(first, log);
            const second = new ShellManager();
            startRunningJob(second, { id: "second" });
            startRunningJob(second, { id: "third" });
            second.settleJob("third", completed(0));
            appendShellStatus(second, log);

            const manager = new ShellManager();
            manager.restoreShellManager(contextFor(log));

            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 1,
                failedCount: 0,
                killedCount: 1,
            });
        });

        it("clears then restores the way session_start does", () => {
            // Contract: session_start empties the module-level state and then rebuilds from the
            // branch; the two calls composed must land on exactly the snapshot's jobs.
            const log = newSessionLog();
            const writer = new ShellManager();
            startRunningJob(writer, { id: "persisted" });
            writer.settleJob("persisted", completed(0));
            appendShellStatus(writer, log);

            const manager = new ShellManager();
            startRunningJob(manager, { id: "stale-module-state" });
            manager.clearAllJobs();
            manager.restoreShellManager(contextFor(log));

            assert.deepEqual(manager.getAllJobsList().map((job) => job.id), ["persisted"]);
            assert.equal(manager.getJob("stale-module-state"), undefined);
        });
    });

    describe("races between settling, clearing and streaming", () => {
        it("keeps one outcome and one counter when a settle races the teardown kill", () => {
            // Contract: a command can finish at the same moment the session shuts down. Whichever
            // settle lands first owns the job; the other must change neither status nor counters.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            assert.equal(manager.settleJob("job-a", completed(0)), true);
            manager.clearAllJobs();

            assert.equal(manager.settleJob("job-a", killed("pi session shutdown")), false);
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            });
        });

        it("settles a job once per turn even when the caller settles twice", () => {
            // Contract: the detached runner and the teardown path both settle; the second call for a
            // job that is no longer running returns false and changes no counter or timestamp.
            const manager = new ShellManager();
            startRunningJob(manager, { id: "job-a" });

            assert.equal(manager.settleJob("job-a", completed(0)), true);
            const settledAt = manager.getJob("job-a")!.finishedAt;
            assert.equal(manager.settleJob("job-a", killed("late")), false);

            assert.equal(manager.getJob("job-a")!.finishedAt, settledAt);
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 1,
                failedCount: 0,
                killedCount: 0,
            });
        });

        it("refuses output once the job is gone and counts nothing twice across many jobs", () => {
            // Contract: the detached runner keeps its own copy of the job id, so output can arrive
            // after teardown. The manager refuses it loudly (the runner guards with settleJob's
            // idempotence) and a bulk teardown still settles every job exactly once.
            const manager = new ShellManager();
            const ids = ["a", "b", "c", "d", "e"];
            for (const id of ids) {
                startRunningJob(manager, { id });
            }
            manager.clearAllJobs();

            for (const id of ids) {
                assert.equal(manager.settleJob(id, killed("aborted")), false);
                assert.equal(manager.settleJob(id, completed(0)), false);
                assert.throws(() => manager.appendOutput(id, "late\n"), /Unknown shell job/);
            }
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            });
        });

        it("is safe to clear repeatedly while nothing is running", () => {
            const manager = new ShellManager();
            const { pi, calls } = recordingPi();

            manager.clearAllJobs(pi);
            manager.clearAllJobs(pi);
            manager.clearAllJobs();

            assert.equal(calls.length, 2, "each pi clear writes its own snapshot");
            assert.deepEqual(manager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            });
        });
    });
});
