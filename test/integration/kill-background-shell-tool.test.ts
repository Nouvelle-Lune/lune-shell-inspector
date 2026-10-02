/**
 * Kill contract of the registered `kill_background_shell` tool.
 *
 * A background `bash` call returns while its command keeps running, and the plugin's own guidance
 * forbids the agent from hunting that process down with `ps`/`pkill`; this tool is the only
 * supported way to stop a shell the agent started. One call kills one managed job through the
 * job's own `AbortController` - the same cancellation `/shell`'s kill key uses - and records an
 * agent-specific reason. A kill is not a clear: the job stays in the `ShellManager` and its output,
 * screen and history stay readable through `background_shell` and `/shell` until `clearJob()` runs.
 *
 * These tests drive real background commands through the registered `bash` tool, so they prove the
 * process tree is actually cancelled and not merely marked killed. Settled or unknown ids are
 * answered as model-facing results, never thrown, and a refusal must not emit another terminal
 * event or notify the agent again. The manager-level operation is covered by
 * `test/unit/shell-manager.test.ts`; the tool schema by `test/integration/extension-registration.test.ts`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { shellManager } from "../../src/shell/shell-manager.ts";
import {
    createTempWorkDir,
    loadRegisteredTool,
    openSession,
    readJobScreen,
    removeTempWorkDir,
    resultText,
    startBackgroundBashCommand,
    waitFor,
    waitForJobSettled,
    type BashToolDefinition,
    type BashToolResult,
    type ExtensionSession,
    type SendMessageCall,
} from "../harness.ts";

/** Arguments the kill tool accepts; exactly one managed shell id per call. */
interface KillParams {
    jobID: string;
}

/** Execute signature of the kill tool; only the params and the result are read. */
type KillExecute = (
    toolCallId: string,
    params: KillParams,
    signal: undefined,
    onUpdate: undefined,
    ctx: undefined,
) => Promise<BashToolResult>;

/** Arguments `background_shell` accepts; used here only to inspect a killed job. */
interface InspectParams {
    jobs?: Array<{ jobID: string; includeOutput?: boolean }>;
}

/** Execute signature of the registered `background_shell` tool. */
type InspectExecute = (
    toolCallId: string,
    params: InspectParams,
    signal: undefined,
    onUpdate: undefined,
    ctx: undefined,
) => Promise<BashToolResult>;

/** Call the kill tool the way pi does and return the text it answers with. */
async function killShell(tool: BashToolDefinition, jobID: string): Promise<string> {
    const execute = tool.execute as unknown as KillExecute;
    return resultText(await execute("call-kill", { jobID }, undefined, undefined, undefined));
}

/** Ask `background_shell` for one job's status line. */
async function inspectShell(tool: BashToolDefinition, jobID: string): Promise<string> {
    const execute = tool.execute as unknown as InspectExecute;
    return resultText(await execute("call-inspect", { jobs: [{ jobID }] }, undefined, undefined, undefined));
}

/** Text of one captured `pi.sendMessage` call. */
function messageText(call: SendMessageCall): string {
    return typeof call.message.content === "string" ? call.message.content : "";
}

/** Notifications the session sent for one job, in call order. */
function notificationsFor(session: ExtensionSession, jobID: string): SendMessageCall[] {
    return session.host.sendMessageCalls.filter(
        (call) => (call.message.details as { jobs: Array<{ shellJobId: string }> }).jobs.some((job) => job.shellJobId === jobID),
    );
}

/** Terminal events observed for one job while the probe is active. */
function watchTerminalEvents(jobID: string): { events: string[]; stop: () => void } {
    const events: string[] = [];
    const unsubscribe = shellManager.subscribe((event) => {
        if (
            (event.type === "job-completed" || event.type === "job-failed" || event.type === "job-killed") &&
            event.id === jobID
        ) {
            events.push(event.type);
        }
    });
    return { events, stop: unsubscribe };
}

/** The counters an empty manager reports. */
const NO_JOBS = { runningCount: 0, completedCount: 0, failedCount: 0, killedCount: 0 };

describe("lune-shell-inspector kill_background_shell invocation", () => {
    let workDir: string;
    let session: ExtensionSession;
    let killTool: BashToolDefinition;

    beforeEach(async () => {
        shellManager.clearAllJobs();
        workDir = createTempWorkDir("kill-background-shell");
        session = await openSession(workDir);
        killTool = loadRegisteredTool(workDir, "kill_background_shell");
    });

    afterEach(async () => {
        // Session teardown aborts whatever the test left running.
        await session.host.emit("session_shutdown", session.ctx);
        removeTempWorkDir(workDir);
    });

    it("kills exactly one running managed shell and leaves it inspectable", async () => {
        // Settled shells exist first so the kill provably moves only the running and killed
        // counters. The target prints a ready line, so the kill reaches a process that already
        // runs rather than a job that never spawned.
        const completed = await startBackgroundBashCommand(session.tool, {
            command: "printf 'finished\\n'",
            ctx: session.ctx,
            toolCallId: "call-already-completed",
        });
        await waitForJobSettled(completed.jobId);
        const failed = await startBackgroundBashCommand(session.tool, {
            command: "printf 'broken\\n'; exit 3",
            ctx: session.ctx,
            toolCallId: "call-already-failed",
        });
        await waitForJobSettled(failed.jobId);

        const targetCommand = "printf 'target-ready\\n'; exec sleep 300";
        const target = await startBackgroundBashCommand(session.tool, {
            command: targetCommand,
            ctx: session.ctx,
            toolCallId: "call-123",
        });
        const other = await startBackgroundBashCommand(session.tool, {
            command: "exec sleep 300",
            ctx: session.ctx,
            toolCallId: "call-bystander",
        });
        await waitFor("the target shell to print its ready line", () =>
            (shellManager.getJob(target.jobId)?.output.content ?? "").includes("target-ready"),
        );
        assert.deepEqual(shellManager.getAllJobsStatusStat(), {
            runningCount: 2,
            completedCount: 1,
            failedCount: 1,
            killedCount: 0,
        }, "the two running shells and the two settled ones must be counted before the kill");

        const text = await killShell(killTool, target.jobId);

        const job = shellManager.getJob(target.jobId);
        assert.ok(job, "a killed shell must stay in the manager until it is explicitly cleared");
        assert.equal(job.status, "killed", "the tool must settle the requested shell as killed");
        assert.equal(job.controller.signal.aborted, true, "the kill must abort the job's own controller");
        assert.equal(job.error, "Shell killed by agent", "the kill must record the agent's reason");
        assert.equal(job.exitCode, undefined, "a killed job has no process exit code");
        assert.ok(job.output.content.includes("target-ready"), `the output collected before the kill must survive, got ${JSON.stringify(job.output.content)}`);
        assert.match(text, /killed/i, `the result must report the kill: ${text}`);
        assert.ok(text.includes(target.jobId), `the result must identify the killed job: ${text}`);

        assert.deepEqual(shellManager.getAllJobsStatusStat(), {
            runningCount: 1,
            completedCount: 1,
            failedCount: 1,
            killedCount: 1,
        }, "only the target shell may move from running to killed");
        const bystander = shellManager.getJob(other.jobId);
        assert.equal(bystander?.status, "running", "only the requested shell may be killed");
        assert.equal(bystander?.controller.signal.aborted, false, "the bystander's process must stay untouched");

        // The killed job stays on the read path: background_shell reports its settled status.
        const inspector = loadRegisteredTool(workDir, "background_shell");
        assert.equal(await inspectShell(inspector, target.jobId), `${target.jobId}: killed - ${targetCommand}`, "the read path must still report the killed shell");
    });

    it("notifies the agent exactly once and keeps the job when the aborted execution rejects", async () => {
        // The kill settles the job before `backgroundOps.exec` rejects with its abort error; that
        // rejection calls settleJob again, and the refused settle must not emit a second kill event,
        // send a second notification, drop the job or rewrite the recorded reason.
        const markerPath = join(workDir, "after-kill.txt");
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: `printf 'ready\\n'; sleep 1; printf 'late\\n' > '${markerPath}'`,
            ctx: session.ctx,
            toolCallId: "call-notify-once",
        });
        await waitFor("the shell to start running", () =>
            (shellManager.getJob(jobId)?.output.content ?? "").includes("ready"),
        );
        const terminalEvents = watchTerminalEvents(jobId);

        try {
            await killShell(killTool, jobId);

            assert.deepEqual(terminalEvents.events, ["job-killed"], "an agent kill must emit exactly one kill event");
            await waitFor("the batched kill notification", () => notificationsFor(session, jobId).length === 1);
            const notifications = notificationsFor(session, jobId);
            assert.equal(notifications.length, 1, "an agent kill must notify exactly once");

            const call = notifications[0]!;
            assert.equal(call.message.customType, "background-shell-notification", "the kill must notify under the shell notification type");
            assert.equal(call.message.display, false, "the notification must not enter the transcript");
            assert.equal(call.options?.triggerTurn, true, "the agent must get a turn to read it");
            assert.equal(call.options?.deliverAs, "steer", "the notification must steer the running turn");
            assert.deepEqual(call.message.details, {
                jobs: [{
                    shellJobId: jobId,
                    status: "killed",
                    exitCode: undefined,
                }],
            }, "the notification must identify the killed shell");

            const text = messageText(call);
            assert.ok(text.startsWith(`Background shell ${jobId} killed.`), `the notification must open with the job id and status: ${text}`);
            assert.ok(text.includes("Error: Shell killed by agent"), `the notification must report the agent's reason: ${text}`);
            assert.ok(
                text.includes("Output:\nready"),
                `the output collected before the kill must reach the agent: ${text}`,
            );

            // The fixture's own deadline is one second; waiting past it means a surviving process
            // would have written, and the runner's abort rejection has been delivered either way.
            await new Promise((resolve) => setTimeout(resolve, 1_500));

            assert.equal(existsSync(markerPath), false, "the killed process must not write its late output");
            assert.deepEqual(terminalEvents.events, ["job-killed"], "a late rejection must not emit a second event");
            assert.equal(notificationsFor(session, jobId).length, 1, "a late rejection must not notify again");

            const job = shellManager.getJob(jobId);
            assert.ok(job, "the notification path must not remove the job");
            assert.equal(job.status, "killed", "the late rejection must not change the status");
            assert.equal(job.error, "Shell killed by agent", "the late rejection must not rewrite the reason");
            assert.deepEqual(shellManager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 0,
                failedCount: 0,
                killedCount: 1,
            }, "the late rejection must not move a counter");
        } finally {
            terminalEvents.stop();
        }
    });

    it("stops the managed process so its late side effect never happens", async () => {
        // The fixture arms itself, then writes a marker after its own delay. Killing it before that
        // point must stop the process tree: a state-only kill would let the marker appear.
        const markerPath = join(workDir, "late-side-effect.txt");
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: `printf 'armed\\n'; sleep 1; printf 'late\\n' > '${markerPath}'`,
            ctx: session.ctx,
            toolCallId: "call-late-side-effect",
        });
        await waitFor("the shell to arm its late side effect", () =>
            (shellManager.getJob(jobId)?.output.content ?? "").includes("armed"),
        );

        const text = await killShell(killTool, jobId);
        assert.match(text, /killed/i, `the result must report the kill: ${text}`);
        assert.equal(shellManager.getJob(jobId)?.status, "killed", "the job must settle as killed");

        // Past the fixture's own deadline, plus a margin for process teardown.
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        assert.equal(existsSync(markerPath), false, "a killed process tree must not keep executing");
        assert.ok(
            !(shellManager.getJob(jobId)?.output.content ?? "").includes("late"),
            `no output may arrive after the kill, got ${JSON.stringify(shellManager.getJob(jobId)?.output.content ?? "")}`,
        );
    });

    it("keeps the killed shell's output, screen and history until it is explicitly cleared", async () => {
        const command = "printf 'kept-one\\n'; printf 'kept-two\\n'; exec sleep 300";
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command,
            ctx: session.ctx,
            toolCallId: "call-history",
        });
        await waitFor("the shell's output to arrive", () =>
            (shellManager.getJob(jobId)?.output.content ?? "").includes("kept-two"),
        );

        await killShell(killTool, jobId);

        const job = shellManager.getJob(jobId);
        assert.ok(job, "kill must stop execution, not remove the job");
        assert.equal(job.status, "killed", "the kill must settle the job as killed");
        assert.equal(shellManager.getJobOutput(jobId), "kept-one\nkept-two\n", "the raw output must stay readable");
        assert.deepEqual(await readJobScreen(jobId), ["kept-one", "kept-two"], "the xterm screen must stay readable");

        // Clearing stays a separate operation: only it drops the settled job and its resources.
        assert.equal(shellManager.clearJob(jobId), true, "a killed job must remain clearable");
        assert.equal(shellManager.getJob(jobId), undefined, "clearing must drop the killed job");
    });

    it("answers an unknown job id without throwing, mutating or notifying", async () => {
        const events: string[] = [];
        const unsubscribe = shellManager.subscribe((event) => events.push(event.type));
        let text = "";

        try {
            await assert.doesNotReject(
                async () => {
                    text = await killShell(killTool, "missing");
                },
                "an unknown job id must be answered, not thrown",
            );
        } finally {
            unsubscribe();
        }

        // Same model-facing phrasing as background_shell, so unknown ids read the same in both tools.
        assert.equal(text, "Unknown background shell: missing", "an unknown job id must be answered in prose");
        assert.deepEqual(events, [], "an unknown id must not emit a manager event");
        assert.deepEqual(shellManager.getAllJobsStatusStat(), NO_JOBS, "an unknown id must not move a counter");
        assert.deepEqual(session.host.sendMessageCalls, [], "an unknown id must not notify the agent");
    });

    for (const status of ["completed", "failed", "killed"] as const) {
        it(`refuses to kill a shell that already ${status}`, async () => {
            const jobId = `call-settled-${status}`;
            const command =
                status === "completed"
                    ? "printf 'done\\n'"
                    : status === "failed"
                        ? "printf 'bad\\n'; exit 3"
                        : "exec sleep 300";
            await startBackgroundBashCommand(session.tool, {
                command,
                ctx: session.ctx,
                toolCallId: jobId,
            });

            if (status === "killed") {
                await killShell(killTool, jobId);
            } else {
                assert.equal((await waitForJobSettled(jobId)).status, status, `the fixture must settle as ${status}`);
            }

            const before = shellManager.getJob(jobId)!;
            const snapshot = {
                status: before.status,
                error: before.error,
                exitCode: before.exitCode,
                finishedAt: before.finishedAt,
                aborted: before.controller.signal.aborted,
                stats: shellManager.getAllJobsStatusStat(),
                notifications: notificationsFor(session, jobId).length,
            };
            const terminalEvents = watchTerminalEvents(jobId);
            let text = "";

            try {
                text = await killShell(killTool, jobId);
            } finally {
                terminalEvents.stop();
            }

            assert.ok(text.includes(jobId), `the refusal must identify the shell: ${text}`);
            assert.match(
                text,
                /(not running|no longer running|already)/i,
                `the refusal must explain that the shell settled: ${text}`,
            );

            const after = shellManager.getJob(jobId);
            assert.ok(after, "a refused kill must not remove the job");
            assert.equal(after.status, snapshot.status, "a refused kill must not change the status");
            assert.equal(after.error, snapshot.error, "a refused kill must not change the reason");
            assert.equal(after.exitCode, snapshot.exitCode, "a refused kill must not change the exit code");
            assert.equal(after.finishedAt, snapshot.finishedAt, "a refused kill must not restamp the finish");
            assert.equal(
                after.controller.signal.aborted,
                snapshot.aborted,
                "a refused kill must not touch the controller",
            );
            assert.deepEqual(shellManager.getAllJobsStatusStat(), snapshot.stats, "a refused kill must not move a counter");
            assert.deepEqual(terminalEvents.events, [], "a refused kill must not emit a terminal event");
            assert.equal(
                notificationsFor(session, jobId).length,
                snapshot.notifications,
                "a refused kill must not notify again",
            );
        });
    }

    it("keeps the first agent kill final when the same job is killed again", async () => {
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "exec sleep 300",
            ctx: session.ctx,
            toolCallId: "call-idempotent",
        });
        const terminalEvents = watchTerminalEvents(jobId);

        try {
            const first = await killShell(killTool, jobId);
            assert.match(first, /killed/i, `the first result must report the kill: ${first}`);

            const killedJob = shellManager.getJob(jobId)!;
            const finishedAt = killedJob.finishedAt;
            assert.ok(finishedAt !== undefined, `a successful kill must stamp the finish, got ${String(finishedAt)}`);
            assert.equal(killedJob.error, "Shell killed by agent", "the first kill must record its reason");
            assert.deepEqual(terminalEvents.events, ["job-killed"], "the first kill must emit one kill event");
            await waitFor("the first batched kill notification", () => notificationsFor(session, jobId).length === 1);
            assert.equal(notificationsFor(session, jobId).length, 1, "the first kill must notify once");

            const second = await killShell(killTool, jobId);

            assert.ok(second.includes(jobId), `the refusal must identify the shell: ${second}`);
            assert.match(second, /(not running|no longer running|already)/i, `the refusal must explain that the shell settled: ${second}`);
            const after = shellManager.getJob(jobId)!;
            assert.equal(after.status, "killed", "the repeated kill must leave the status as killed");
            assert.equal(after.error, "Shell killed by agent", "a repeated kill must not rewrite the reason");
            assert.equal(after.finishedAt, finishedAt, "a repeated kill must not restamp the finish");
            assert.equal(after.controller.signal.aborted, true, "the repeated kill must keep the abort");
            assert.deepEqual(
                shellManager.getAllJobsStatusStat(),
                { runningCount: 0, completedCount: 0, failedCount: 0, killedCount: 1 },
                "a repeated kill must not move a counter",
            );
            assert.deepEqual(terminalEvents.events, ["job-killed"], "a repeated kill must not emit another event");
            assert.equal(notificationsFor(session, jobId).length, 1, "a repeated kill must not notify again");
        } finally {
            terminalEvents.stop();
        }
    });
});
