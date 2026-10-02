/**
 * Session lifecycle persistence: the eight end-to-end scenarios.
 *
 * Every scenario composes what pi does - `session_start`, `session_shutdown`, `session_before_tree`,
 * `session_tree`, the session being reopened after a reload, `/quit`, `/resume`, `/new`, `/fork` -
 * with the real extension, the real `ShellManager` singleton and a **real pi `SessionManager`**
 * (`SessionManager.inMemory()`). The tree, its leaf and `pi.appendEntry` are therefore pi's own
 * implementation: an entry appended during `session_before_tree` lands on the leaf that the branch
 * switch has not moved yet, exactly as it does in a live session.
 *
 * The scenarios:
 *
 * 1. normal shutdown -> start
 * 2. reload (and three consecutive reloads, with no listener growth)
 * 3. quit -> resume, restored from the session entries alone
 * 4. resume another session (the previous session's jobs must not survive)
 * 5. new (the new session starts empty; the old one still records its final state)
 * 6. fork the current leaf
 * 7. fork a historical node (the fork's branch, not the original's leaf, decides)
 * 8. tree A -> B -> A (each branch restores its own snapshot; no cross-branch snapshot)
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ShellManager, shellManager } from "../../src/shell/shell-manager.ts";
import {
    FakeSessionLog,
    createFakeUi,
    createFakeContext,
    createTempWorkDir,
    registerExtension,
    removeTempWorkDir,
    type FakeExtensionUi,
    type FakePiHost,
    type SeededSessionEntry,
} from "../harness.ts";
import {
    SHELL_STATUS_ENTRY,
    appendShellStatus,
    newSessionLog,
    type ShellStatusSnapshot,
} from "../helpers/session-log.ts";

/** Widget key the shell dock uses. */
const WIDGET_ID = "lune-shell-inspector";

/** A job started through the manager; the controller lets a test assert the process was stopped. */
interface ManagedJob {
    id: string;
    controller: AbortController;
}

/**
 * pi's `/tree` navigation, in pi's order: `session_before_tree` fires while the session is still on
 * the old leaf, then the leaf moves, then `session_tree` fires.
 *
 * The split matters: the extension persists the departing branch's shell state in the first event
 * (when `pi.appendEntry` still writes to that branch) and only restores in the second.
 */
async function navigateTree(
    host: FakePiHost,
    ctx: ExtensionContext,
    log: FakeSessionLog,
    targetId: string,
): Promise<void> {
    const oldLeafId = log.leafId;
    await host.emit("session_before_tree", ctx, {
        preparation: {
            targetId,
            oldLeafId,
            commonAncestorId: null,
            entriesToSummarize: [],
            userWantsSummary: false,
        },
        signal: new AbortController().signal,
    });
    log.setLeaf(targetId);
    await host.emit("session_tree", ctx, { newLeafId: targetId, oldLeafId });
}

/**
 * pi plus the extension instances of one process, driving the lifecycle against a session log.
 *
 * The driver owns the session and the UI of the *user session*: reopening the same session reuses
 * the same log (and therefore the same `SessionManager`), which is what models `/reload`,
 * `/resume` on the same file and a fresh pi process over a persisted session.
 */
class LifecycleDriver {
    readonly ui: FakeExtensionUi;
    sessionLog: FakeSessionLog;
    host?: FakePiHost;
    ctx?: ExtensionContext;
    private readonly workDir: string;

    constructor(
        workDir: string,
        sessionLog: FakeSessionLog = newSessionLog(),
        ui: FakeExtensionUi = createFakeUi(),
    ) {
        this.workDir = workDir;
        this.sessionLog = sessionLog;
        this.ui = ui;
    }

    /** Load the extension (a fresh one, as after `/reload`) and fire `session_start`. */
    async start(reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup"): Promise<void> {
        this.host = registerExtension(this.workDir, this.sessionLog);
        this.ctx = createFakeContext(this.workDir, { ui: this.ui, sessionLog: this.sessionLog });
        await this.host.emit("session_start", this.ctx, { reason });
    }

    /** Fire `session_shutdown`; the extension persists the shell snapshot through `pi.appendEntry`. */
    async stop(reason: "quit" | "reload" | "new" | "resume" | "fork" = "quit"): Promise<void> {
        if (!this.host || !this.ctx) {
            throw new Error("no running session to stop");
        }
        await this.host.emit("session_shutdown", this.ctx, { reason });
    }

    /** Navigate the session tree the way pi's `navigateTree` does. */
    async tree(targetId: string): Promise<void> {
        if (!this.host || !this.ctx) {
            throw new Error("no running session to navigate");
        }
        await navigateTree(this.host, this.ctx, this.sessionLog, targetId);
    }

    /** Start a job in the manager, the way the background runner does. */
    job(id: string, command = "sleep 30"): ManagedJob {
        const controller = new AbortController();
        shellManager.startJob({ id, command, cwd: this.workDir, controller });
        return { id, controller };
    }

    /** Settle a job in the manager. */
    settle(id: string, outcome: Parameters<typeof shellManager.settleJob>[1]): boolean {
        return shellManager.settleJob(id, outcome);
    }

    /** The single dock line, or undefined when the dock is not mounted. */
    dockText(): string | undefined {
        const content = this.ui.mountedWidget("belowEditor", WIDGET_ID);
        if (content === undefined) {
            return undefined;
        }
        assert.ok(Array.isArray(content), "the dock must be mounted as an array of lines");
        assert.equal(content.length, 1, "the dock must stay a single line");
        return content[0];
    }

    /** Widget calls that mounted or cleared the shell dock (including the refresh timer). */
    get dockCalls(): number {
        return this.ui.widgetCalls.filter((call) => call.key === WIDGET_ID).length;
    }
}

/** Run a test body with a temporary working directory and a clean manager. */
async function withWorkDir(label: string, body: (workDir: string) => Promise<void>): Promise<void> {
    const workDir = createTempWorkDir(label);
    try {
        await body(workDir);
    } finally {
        removeTempWorkDir(workDir);
    }
}

/** Start a job in an arbitrary manager, the way the background runner does. */
function startJobIn(manager: ShellManager, id: string, command: string): AbortController {
    const controller = new AbortController();
    manager.startJob({ id, command, cwd: "/work", controller });
    return controller;
}

/**
 * Append one job snapshot to `log` through the real writer.
 *
 * A still-running job is killed by `clearAllJobs(pi)`, which is what makes a seeded "running" job
 * restore as killed - the same thing that happens to a live shell at session teardown.
 */
function appendSeedJob(
    log: FakeSessionLog,
    id: string,
    command: string,
    outcome: Parameters<ShellManager["settleJob"]>[1] | "running",
): void {
    const writer = new ShellManager();
    startJobIn(writer, id, command);
    if (outcome !== "running") {
        writer.settleJob(id, outcome);
    }
    appendShellStatus(writer, log);
}

/** Job ids recorded in one shell snapshot entry. */
function jobIdsOf(log: FakeSessionLog, entryId: string): string[] {
    const snapshot = log.entry(entryId)?.data as ShellStatusSnapshot | undefined;
    return snapshot?.jobs.map((job) => job.id) ?? [];
}

/** Shell snapshot entries on the session's active branch, oldest first. */
function shellEntriesOnBranch(log: FakeSessionLog): string[] {
    return log
        .getBranch()
        .filter((entry) => entry.customType === SHELL_STATUS_ENTRY)
        .map((entry) => entry.id);
}

/** Job ids the active branch's snapshots would restore. */
function branchJobs(log: FakeSessionLog): string[] {
    return shellEntriesOnBranch(log).flatMap((entryId) => jobIdsOf(log, entryId));
}

/** Every shell snapshot entry of the session, in append order. */
function shellEntries(log: FakeSessionLog): string[] {
    return log
        .entries()
        .filter((entry) => entry.customType === SHELL_STATUS_ENTRY)
        .map((entry) => entry.id);
}

/**
 * Rebuild a new session file containing only the branch up to `leafId` - what pi's `/fork` does.
 *
 * Seeding the new log from the source branch reuses the original entry ids, so a fork's snapshots
 * stay recognizable in the assertions.
 */
function forkSessionLog(source: FakeSessionLog, leafId: string | null): FakeSessionLog {
    const entries: SeededSessionEntry[] = [];

    // Walk parent links from the fork node, exactly like SessionManager.getBranch().
    let current = leafId ? source.entry(leafId) : undefined;
    while (current) {
        entries.push({
            id: current.id,
            parentId: current.parentId,
            type: current.type,
            customType: current.customType,
            data: current.data,
        });
        current = current.parentId ? source.entry(current.parentId) : undefined;
    }
    entries.reverse();

    // A new session file holding only that branch, replayed by pi's own session loader.
    return newSessionLog({ entries });
}

describe("lune-shell-inspector session persistence", () => {
    afterEach(() => {
        shellManager.clearAllJobs();
    });

    it("1. shutdown -> start: the killed job is persisted and restored with its final status", async () => {
        await withWorkDir("persist-roundtrip", async (workDir) => {
            const driver = new LifecycleDriver(workDir);
            await driver.start();

            const done = driver.job("job-completed", "echo done");
            driver.settle(done.id, { type: "completed", exitCode: 0 });
            const live = driver.job("job-running", "sleep 30");
            assert.equal(shellManager.getJob("job-running")!.status, "running", "the job must be running before the shutdown");

            await driver.stop("quit");

            assert.equal(live.controller.signal.aborted, true, "shutdown must stop the live process");
            assert.deepEqual(shellManager.getAllJobsList(), [], "the runtime manager must be emptied");
            assert.equal(driver.dockText(), undefined, "the dock must be cleared on shutdown");
            const snapshotIds = shellEntries(driver.sessionLog);
            assert.equal(snapshotIds.length, 1, "shutdown must persist exactly one snapshot");
            const snapshot = driver.sessionLog.entry(snapshotIds[0]!)!.data as ShellStatusSnapshot;
            assert.deepEqual(
                snapshot.jobs.map((job) => [job.id, job.status]),
                [["job-completed", "completed"], ["job-running", "killed"]],
                "the persisted snapshot must record the completed job and the shutdown-killed one",
            );

            // A new pi process reopens the same session.
            const reopened = new LifecycleDriver(workDir, driver.sessionLog, driver.ui);
            await reopened.start("startup");

            assert.deepEqual(
                shellManager.getAllJobsList().map((job) => [job.id, job.status]),
                [["job-completed", "completed"], ["job-running", "killed"]],
                "the reopened session must restore every persisted job with its final status",
            );
            assert.equal(shellManager.getJob("job-running")!.error, "pi session shutdown", "the restored shell must keep the lifecycle kill reason");
            assert.equal(shellManager.getJob("job-running")!.output.content, "", "a restored shell must be inert state with no output");
            assert.equal(shellManager.getJob("job-completed")!.exitCode, 0, "a restored completed shell must keep its exit code");
            assert.match(reopened.dockText() ?? "", /^2 shells · 1 completed · 1 killed · \/shell to open$/, "the restored shell list must be summarized in the dock");

            await reopened.stop("quit");
        });
    });

    it("2. reload: a dead session's jobs stay dead and the snapshot is rebuilt", async () => {
        await withWorkDir("persist-reload", async (workDir) => {
            const driver = new LifecycleDriver(workDir);
            await driver.start();

            const a = driver.job("A", "sleep 30");
            const b = driver.job("B", "echo b");
            driver.settle(b.id, { type: "completed", exitCode: 0 });

            await driver.stop("reload");
            assert.equal(a.controller.signal.aborted, true, "reload must not leave a process behind");

            await driver.start("reload");

            assert.equal(shellManager.getJob("A")!.status, "killed", "the reload must restore A as killed");
            assert.equal(shellManager.getJob("B")!.status, "completed", "the reload must restore B as completed");
            assert.deepEqual(shellManager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 1,
                failedCount: 0,
                killedCount: 1,
            }, "the restored counters must match the restored jobs");
            assert.match(driver.dockText() ?? "", /^2 shells · 1 completed · 1 killed · \/shell to open$/, "the restored shell list must be summarized in the dock");

            await driver.stop("quit");
        });
    });

    it("2b. three consecutive reloads render once per event and grow no listeners", async () => {
        await withWorkDir("persist-reload-storm", async (workDir) => {
            const driver = new LifecycleDriver(workDir);
            await driver.start();
            const live = driver.job("A", "sleep 30");

            for (let round = 0; round < 3; round++) {
                await driver.stop("reload");
                await driver.start("reload");
                assert.equal(live.controller.signal.aborted, true, `reload ${round + 1} must stop the process`);

                // session_start renders once; the restored snapshot itself must not re-render per job.
                const before = driver.dockCalls;
                const killedBeforeProbe = shellManager.getAllJobsStatusStat().killedCount;
                driver.job(`probe-${round}`, "echo probe");
                assert.equal(driver.dockCalls, before + 1, `one manager event must render the dock once (round ${round + 1})`);
                shellManager.settleJob(`probe-${round}`, { type: "killed", error: "probe" });
                assert.equal(driver.dockCalls, before + 2, "the settle must render exactly once more");

                // Each round restores the previous round's snapshot (which already holds the earlier
                // probes), so the delta - not the absolute count - is what proves nothing double-counts.
                assert.equal(
                    shellManager.getAllJobsStatusStat().killedCount,
                    killedBeforeProbe + 1,
                    `killing one probe must move the killed count once (round ${round + 1})`,
                );
            }

            await driver.stop("quit");
        });
    });

    it("3. quit -> resume: a fresh manager restores from the session entries alone", async () => {
        await withWorkDir("persist-quit-resume", async (workDir) => {
            // The session was written by a process that is gone: one snapshot holding both jobs.
            const log = newSessionLog();
            const writer = new ShellManager();
            startJobIn(writer, "job-done", "echo done");
            writer.settleJob("job-done", { type: "completed", exitCode: 0 });
            startJobIn(writer, "job-live", "sleep 30");
            appendShellStatus(writer, log);

            // A new process: no manager state, no history of the previous extension instance.
            const resumed = new LifecycleDriver(workDir, log);
            await resumed.start("resume");

            assert.deepEqual(
                shellManager.getAllJobsList().map((job) => [job.id, job.status]),
                [["job-done", "completed"], ["job-live", "killed"]],
                "a resumed session must rebuild its jobs from the stored snapshot alone",
            );
            assert.match(resumed.dockText() ?? "", /^2 shells · 1 completed · 1 killed · \/shell to open$/, "the resumed shell list must be summarized in the dock");

            await resumed.stop("quit");
        });
    });

    it("4. resume another session: the previous session's jobs do not survive", async () => {
        await withWorkDir("persist-resume-other", async (workDir) => {
            const logA = newSessionLog();
            appendSeedJob(logA, "A1", "echo a", { type: "completed", exitCode: 0 });
            const logB = newSessionLog();
            appendSeedJob(logB, "B1", "exit 1", { type: "failed", error: "Command exited with code 1", exitCode: 1 });

            const driver = new LifecycleDriver(workDir, logA);
            await driver.start();
            assert.equal(shellManager.getJob("A1")!.status, "completed", "the first session must restore its own persisted job");

            await driver.stop("resume");

            // `/resume` opens a different session file.
            driver.sessionLog = logB;
            await driver.start("resume");

            assert.deepEqual(shellManager.getAllJobsList().map((job) => job.id), ["B1"], "the resumed session must list only its own job");
            assert.equal(shellManager.getJob("A1"), undefined, "A1 must not leak into the resumed session");
            assert.equal(shellManager.getJob("B1")!.status, "failed", "the resumed job must keep its stored status");
            assert.equal(shellManager.getJob("B1")!.error, "Command exited with code 1", "the resumed job must keep its stored reason");

            await driver.stop("quit");
        });
    });

    it("5. new: the new session starts empty and the old one keeps its final snapshot", async () => {
        await withWorkDir("persist-new", async (workDir) => {
            const oldLog = newSessionLog();
            const driver = new LifecycleDriver(workDir, oldLog);
            await driver.start();

            const a = driver.job("A", "sleep 30");
            const b = driver.job("B", "echo b");
            driver.settle(b.id, { type: "completed", exitCode: 0 });

            await driver.stop("new");
            assert.equal(a.controller.signal.aborted, true, "ending the old session must stop its shell");

            const persisted = oldLog.entry(shellEntries(oldLog).at(-1)!)!.data as ShellStatusSnapshot;
            assert.deepEqual(
                persisted.jobs.map((job) => [job.id, job.status]),
                [["A", "killed"], ["B", "completed"]],
                "the old session must record what happened to its shells",
            );

            // `/new` starts an empty session: its own log holds no shell entry, so nothing restores.
            driver.sessionLog = newSessionLog();
            await driver.start("new");

            assert.deepEqual(shellManager.getAllJobsList(), [], "a new session must start with no shells");
            assert.deepEqual(shellManager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            }, "a new session must start with empty counters");
            assert.equal(driver.dockText(), undefined, "an empty session mounts no dock");

            await driver.stop("quit");
        });
    });

    it("6. fork the current leaf: the fork inherits the branch's final shell state", async () => {
        await withWorkDir("persist-fork-leaf", async (workDir) => {
            const log = newSessionLog();
            const original = new LifecycleDriver(workDir, log);
            await original.start();
            const a = original.job("A", "echo a");
            original.settle(a.id, { type: "completed", exitCode: 0 });
            const b = original.job("B", "sleep 30");

            await original.stop("fork");
            assert.equal(b.controller.signal.aborted, true, "forking must stop the live shell before the new session starts");

            // `/fork` creates a new session file from the branch up to the current leaf.
            const fork = new LifecycleDriver(workDir, forkSessionLog(log, log.leafId));
            await fork.start("fork");

            assert.deepEqual(
                shellManager.getAllJobsList().map((job) => [job.id, job.status]),
                [["A", "completed"], ["B", "killed"]],
                "the fork must inherit the branch's final shell state",
            );

            await fork.stop("quit");
        });
    });

    it("7. fork a historical node: the fork sees only the branch up to that node", async () => {
        await withWorkDir("persist-fork-history", async (workDir) => {
            // Session: message 1, snapshot holding A1, message 2, snapshot holding only A2 (the
            // later snapshot differs from the earlier one, which is what the fork must respect).
            const log = newSessionLog();
            log.appendMessage("m1");
            const writer = new ShellManager();
            startJobIn(writer, "A1", "echo a");
            writer.settleJob("A1", { type: "completed", exitCode: 0 });
            appendShellStatus(writer, log);
            const snapshot1Entry = log.leafId!;
            log.appendMessage("m2");
            startJobIn(writer, "A2", "sleep 30");
            appendShellStatus(writer, log);
            assert.deepEqual(jobIdsOf(log, snapshot1Entry), ["A1"], "guard: the first snapshot holds only A1");
            assert.deepEqual(jobIdsOf(log, log.leafId!), ["A2"], "guard: the second snapshot holds only A2");

            // Fork at the first historical node: only m1 and the older snapshot are on the branch.
            const forkLog = forkSessionLog(log, snapshot1Entry);
            const fork = new LifecycleDriver(workDir, forkLog);
            await fork.start("fork");

            assert.deepEqual(
                shellManager.getAllJobsList().map((job) => job.id),
                ["A1"],
                "the fork must restore the snapshot on its own branch, not the original session's newest one",
            );
            assert.equal(shellManager.getJob("A2"), undefined, "the fork must not see a job outside its branch");
            assert.deepEqual(jobIdsOf(forkLog, snapshot1Entry), ["A1"], "the fork's own snapshot must stay its source of truth");
            assert.deepEqual(shellEntries(forkLog), [snapshot1Entry], "the fork must hold exactly its branch's snapshot");

            await fork.stop("quit");
        });
    });

    it("8. tree A -> B -> A restores each branch and never moves a snapshot across branches", async () => {
        await withWorkDir("persist-tree", async (workDir) => {
            // Shared trunk with two sibling branches, each holding its own shell snapshot. The branch
            // drivers model the two "user sessions" that created the snapshots; navigating between
            // them is one pi process moving its leaf.
            const log = newSessionLog();
            const rootId = log.appendMessage("root").id;

            const branchASources = new LifecycleDriver(workDir, log);
            await branchASources.start();
            const a1 = branchASources.job("A1", "echo a");
            branchASources.settle(a1.id, { type: "completed", exitCode: 0 });
            const a2 = branchASources.job("A2", "sleep 30");
            await branchASources.stop("reload"); // persists A's final snapshot under A's leaf
            const snapshotA = log.leafId!;

            log.setLeaf(rootId);
            const branchBSources = new LifecycleDriver(workDir, log);
            await branchBSources.start();
            const b1 = branchBSources.job("B1", "exit 1");
            branchBSources.settle(b1.id, { type: "failed", error: "Command exited with code 1", exitCode: 1 });
            await branchBSources.stop("reload");
            const snapshotB = log.leafId!;

            assert.deepEqual(
                [snapshotA, snapshotB].map((id) => jobIdsOf(log, id)),
                [["A1", "A2"], ["B1"]],
                "guard: A's final snapshot holds A1+A2 and B's holds B1",
            );

            const manager = new LifecycleDriver(workDir, log);
            await manager.start();

            // ---- arrive on branch A: pi's `branch()` then `session_tree` (restore only) ----
            log.setLeaf(snapshotA);
            await manager.tree(snapshotA);
            assert.deepEqual(shellManager.getAllJobsList().map((job) => job.id), ["A1", "A2"], "arriving on A must restore A's jobs");
            assert.equal(shellManager.getJob("B1"), undefined, "B's job must not appear on A");
            assert.equal(shellManager.getJob("A2")!.status, "killed", "A's running shell was killed at A's teardown");
            assert.equal(shellManager.getJob("A1")!.status, "completed", "A's finished shell must keep its status");

            // ---- A -> B: B's state; A's teardown snapshot lands on A's own branch ----
            const beforeB = log.entries().length;
            await manager.tree(snapshotB);

            assert.equal(a2.controller.signal.aborted, true, "leaving A must stop A's live shell");
            assert.deepEqual(
                shellManager.getAllJobsList().map((job) => job.id),
                ["B1"],
                "B's branch must restore only B's snapshot",
            );
            assert.equal(shellManager.getJob("A1"), undefined, "A's completed job must not leak into B");
            assert.equal(shellManager.getJob("A2"), undefined, "A's live job must not leak into B");
            assert.equal(shellManager.getJob("B1")!.status, "failed", "B's job must keep its stored failure status");

            // Exactly one entry was appended - A's own teardown snapshot, under A's leaf.
            const addedLeavingA = log.entries().slice(beforeB);
            assert.equal(addedLeavingA.length, 1, "leaving A appends exactly one entry");
            assert.equal(addedLeavingA[0]!.customType, SHELL_STATUS_ENTRY, "the appended entry must be a shell snapshot");
            assert.deepEqual(
                jobIdsOf(log, addedLeavingA[0]!.id),
                ["A1", "A2"],
                "the appended snapshot must describe the branch that was left",
            );
            assert.ok(
                log.getBranch(addedLeavingA[0]!.parentId ?? undefined).some((entry) => entry.id === snapshotA),
                `the appended snapshot must hang off A's branch, not B's, got ${JSON.stringify(log.getBranch(addedLeavingA[0]!.parentId ?? undefined).map((entry) => entry.id))}`,
            );

            // B's active branch must hold B's own snapshot and nothing an A teardown added.
            assert.deepEqual(shellEntriesOnBranch(log), [snapshotB], "A's teardown snapshot must not reach B");
            assert.equal(branchJobs(log).join(","), "B1", "B's branch must not contain any of A's jobs");

            // ---- B -> A: A's final state again, B's snapshot untouched ----
            const entriesBeforeReturn = log.entries().length;
            await manager.tree(snapshotA);

            assert.equal(
                b1.controller.signal.aborted,
                false,
                "B's shell had already settled, so leaving B must not abort its controller",
            );
            assert.deepEqual(
                shellManager.getAllJobsList().map((job) => job.id),
                ["A1", "A2"],
                "returning to A must restore A's snapshot, not B's",
            );
            assert.equal(shellManager.getJob("A2")!.status, "killed", "A's live shell must come back as killed");
            assert.equal(shellManager.getJob("A1")!.status, "completed", "A's finished shell must keep its status");
            assert.equal(shellManager.getJob("B1"), undefined, "B's job must not appear on A");

            const addedLeavingB = log.entries().slice(entriesBeforeReturn);
            assert.equal(addedLeavingB.length, 1, "leaving B appends exactly one entry");
            assert.deepEqual(jobIdsOf(log, addedLeavingB[0]!.id), ["B1"], "B's teardown snapshot describes B");
            assert.deepEqual(shellEntriesOnBranch(log), [snapshotA], "B's teardown snapshot must not reach A");
            assert.equal(branchJobs(log).join(","), "A1,A2", "A's branch must not contain any of B's jobs");
        });
    });
});
