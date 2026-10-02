/**
 * Background shell notification contract.
 *
 * Terminal job events (completed, failed, killed) are batched into steering messages, so the agent
 * learns about detached shells it could no longer observe. Non-terminal events stay silent.
 * Direct manager clears notify for kills while subscribed; session lifecycle clears unsubscribe
 * first and stay silent. Pending notifications are cancelled on unsubscribe, so they cannot leak
 * into another session. Repeated settles cannot duplicate a notification.
 * `pi.sendMessage` belongs to pi's lifecycle, not to the extension: the API returns void and pi
 * attaches its own rejection handling. Errors visible to the buffer (including synchronous throws
 * from a stale API) are contained, reported through the session UI, and retried at most twice.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { shellManager } from "../../src/shell/shell-manager.ts";
import { registerBackgroundShellNotifications } from "../../src/shell/shell-notification.ts";
import {
    createFakeContext,
    createFakeUi,
    createTempWorkDir,
    openSession,
    registerExtension,
    removeTempWorkDir,
    startBackgroundBashCommand,
    waitFor,
    waitForJobSettled,
    type ExtensionSession,
    type SendMessageCall,
} from "../harness.ts";

/** Text of one captured `pi.sendMessage` call. */
function messageText(call: SendMessageCall): string {
    return typeof call.message.content === "string" ? call.message.content : "";
}

/** One captured `pi.sendMessage` call that must exist, with the array type restored after narrowing. */
function sentMessage(calls: readonly SendMessageCall[], index: number): SendMessageCall {
    const call = calls[index];
    if (!call) {
        throw new Error(`expected a sendMessage call at index ${index}`);
    }
    return call;
}

/** Start a running job directly in the manager, the way the background runner does. */
function startJob(id: string, command: string): void {
    shellManager.startJob({ id, command, cwd: "/work", controller: new AbortController() });
}

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

describe("lune-shell-inspector background notifications", () => {
    beforeEach(() => {
        shellManager.clearAllJobs();
    });

    afterEach(() => {
        shellManager.clearAllJobs();
    });

    it("sends one completion notification with the job metadata and the steering options", async () => {
        // Contract: the immediate tool result cannot report the outcome, so the settled job sends
        // one steering message carrying the id, status, command, exit code and output, without ever
        // becoming a visible transcript row.
        await withSession("notify-completed", async (session) => {
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "echo notify-done",
                ctx: session.ctx,
                toolCallId: "call-notify-completed",
            });

            const settled = await waitForJobSettled(jobId);
            assert.equal(settled.status, "completed", "the job must settle before it can notify");
            await waitFor("the batched shell notification", () => session.host.sendMessageCalls.length === 1);
            assert.equal(session.host.sendMessageCalls.length, 1, "one terminal event must notify once");

            const call = session.host.sendMessageCalls[0]!;
            const text = messageText(call);

            assert.equal(call.message.customType, "background-shell-notification", "the notification must use the extension's custom type");
            assert.equal(call.message.display, false, "the notification must not enter the transcript");
            assert.equal(call.options?.triggerTurn, true, "the agent must get a turn to read it");
            assert.equal(call.options?.deliverAs, "steer", "the notification must steer the running turn");
            assert.deepEqual(call.message.details, {
                jobs: [{
                    shellJobId: jobId,
                    status: "completed",
                    exitCode: 0,
                }],
            }, "the notification must identify the job and its outcome");

            assert.ok(text.startsWith(`Background shell ${jobId} completed.`), `the notification must open with the job id and status: ${text}`);
            assert.ok(text.includes("Command: echo notify-done"), `the notification must report the command: ${text}`);
            assert.ok(text.includes("Exit code: 0"), `the notification must report the exit code: ${text}`);
            assert.ok(text.endsWith(`Output:\n${settled.output.content}`), `the notification must end with the job output: ${text}`);
            assert.ok(!text.includes("undefined"), "absent optional fields must be omitted, not printed");

            // The detached execution reports its outcome in the same turn; after its promise has
            // fully settled, the job must not have notified a second time.
            await new Promise((resolve) => setTimeout(resolve, 300));
            assert.equal(session.host.sendMessageCalls.length, 1, "a natural completion must notify exactly once");
        });
    });

    it("notifies a failed job with its error and no exit code", async () => {
        await withSession("notify-failed", async (session) => {
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "sleep 5",
                timeout: 1,
                ctx: session.ctx,
                toolCallId: "call-notify-failed",
            });

            const settled = await waitForJobSettled(jobId);
            assert.equal(settled.status, "failed", "the timed-out job must fail before it notifies");
            await waitFor("the batched shell notification", () => session.host.sendMessageCalls.length === 1);
            assert.equal(session.host.sendMessageCalls.length, 1, "a failed job must notify once");

            const text = messageText(session.host.sendMessageCalls[0]!);

            assert.ok(text.startsWith(`Background shell ${jobId} failed.`), `the notification must open with the job id and status: ${text}`);
            assert.ok(text.includes("Error: timeout:1"), `the notification must report the failure reason: ${text}`);
            assert.ok(!text.includes("Exit code:"), "a failed execution reports no process exit code");
            assert.ok(!text.includes("undefined"), `absent optional fields must be omitted: ${text}`);
        });
    });

    it("notifies a killed job once, with the kill reason", async () => {
        await withSession("notify-killed", async (session) => {
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "sleep 5",
                ctx: session.ctx,
                toolCallId: "call-notify-killed",
            });

            assert.equal(shellManager.settleJob(jobId, { type: "killed", error: "manual kill" }), true, "the explicit kill must be accepted");
            assert.equal(shellManager.getJob(jobId)?.controller.signal.aborted, true, "the kill must abort the job's controller");

            await waitFor("the batched shell notification", () => session.host.sendMessageCalls.length === 1);
            assert.equal(session.host.sendMessageCalls.length, 1, "a killed job must notify once");
            const text = messageText(session.host.sendMessageCalls[0]!);

            assert.ok(text.startsWith(`Background shell ${jobId} killed.`), `the notification must open with the job id and status: ${text}`);
            assert.ok(text.includes("Error: manual kill"), `the notification must report the kill reason: ${text}`);
            assert.ok(!text.includes("undefined"), `absent optional fields must be omitted: ${text}`);
        });
    });

    it("notifies a non-zero exit as a failure with its exit code and reason", async () => {
        await withSession("notify-exit-code", async (session) => {
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "printf 'partial\\n'; exit 7",
                ctx: session.ctx,
                toolCallId: "call-notify-exit-code",
            });

            const settled = await waitForJobSettled(jobId);
            assert.equal(settled.status, "failed", "the non-zero exit must settle as failed");
            await waitFor("the batched shell notification", () => session.host.sendMessageCalls.length === 1);
            assert.equal(session.host.sendMessageCalls.length, 1, "a non-zero exit must notify once");

            const text = messageText(session.host.sendMessageCalls[0]!);

            assert.ok(text.startsWith(`Background shell ${jobId} failed.`), `the notification must open with the job id and status: ${text}`);
            assert.ok(text.includes("Exit code: 7"), `the notification must report the exit code: ${text}`);
            assert.ok(text.includes("Error: Background shell exited with code 7"), `the notification must report the failure reason: ${text}`);
            assert.ok(text.endsWith("Output:\npartial\n"), `the notification must end with the output produced before the failure: ${text}`);

            await new Promise((resolve) => setTimeout(resolve, 300));
            assert.equal(session.host.sendMessageCalls.length, 1, "a failed execution must notify exactly once");
        });
    });

    it("stays silent for non-terminal events and reports the session's own clear as a kill", async () => {
        // Contract: only a settled job is worth interrupting for; started and output events must not
        // wake the agent. The clear session_start performs settles the running job as killed, and
        // that terminal event notifies - exactly once.
        await withSession("notify-silent", async (session) => {
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "sleep 1; printf 'late\\n'",
                ctx: session.ctx,
                toolCallId: "call-notify-silent",
            });

            shellManager.appendOutput(jobId, "");
            assert.deepEqual(session.host.sendMessageCalls, [], "started and output events must stay silent");

            shellManager.clearAllJobs();

            // Give the aborted execution time to reject and reach its refused settle.
            await new Promise((resolve) => setTimeout(resolve, 300));

            await waitFor("the batched shell notification", () => session.host.sendMessageCalls.length === 1);
            assert.equal(session.host.sendMessageCalls.length, 1, "the teardown kill notifies once");
            const notification = sentMessage(session.host.sendMessageCalls, 0);
            assert.deepEqual(notification.message.details, {
                jobs: [{
                    shellJobId: jobId,
                    status: "killed",
                    exitCode: undefined,
                }],
            }, "the teardown kill must identify the job and its outcome");
        });
    });

    it("reports a spilled job as a bounded tail pointing at the complete file", async () => {
        // Contract: the notification uses getJobOutput(), so a job whose output crossed pi's limits
        // sends the retained tail plus the file path - never the whole flood and never the raw
        // JobOutput object.
        await withSession("notify-spilled", async (session) => {
            startJob("job-spilled", "noisy-command");
            const full = Array.from({ length: 2500 }, (_, index) => `L${index}`).join("\n");
            shellManager.appendOutput("job-spilled", full);
            shellManager.settleJob("job-spilled", { type: "completed", exitCode: 0 });

            const path = shellManager.getJob("job-spilled")?.output.fullOutputPath;
            assert.ok(path, `guard: the flood must have spilled, got ${String(path)}`);

            await waitFor("the batched shell notification", () => session.host.sendMessageCalls.length === 1);
            assert.equal(session.host.sendMessageCalls.length, 1, "a spilled job must notify once");
            const text = messageText(session.host.sendMessageCalls[0]!);

            assert.ok(text.includes(`[Output truncated. Full output: ${path}]`), `the notification must point at the spill file: ${text}`);
            assert.ok(text.includes("L2499"), `the newest line must reach the agent, got ${JSON.stringify(text.slice(-200))}`);
            assert.ok(!text.includes("L0\n"), `the dropped head must not reach the agent, got ${JSON.stringify(text.slice(0, 200))}`);
            assert.ok(!text.includes("[object Object]"), `the structured output must be rendered, got ${JSON.stringify(text.slice(0, 400))}`);
            assert.ok(!text.includes("Showing last"), `the banner must not claim line numbers the counter cannot supply, got ${JSON.stringify(text.slice(0, 200))}`);
            assert.ok(text.length < full.length, `the reported text must stay bounded, reported ${text.length} vs full ${full.length} characters`);

            rmSync(path, { force: true });
        });
    });

    it("sends exactly one notification per job even when settles repeat", async () => {
        await withSession("notify-once", async (session) => {
            startJob("job-once", "echo once");

            assert.equal(shellManager.settleJob("job-once", { type: "completed", exitCode: 0 }), true, "the first settle must be accepted");
            assert.equal(shellManager.settleJob("job-once", { type: "failed", error: "late" }), false, "a second settle must be refused");

            await waitFor("the batched shell notification", () => session.host.sendMessageCalls.length === 1);
            assert.equal(session.host.sendMessageCalls.length, 1, "the refused settle must not notify again");
        });
    });

    it("keeps the settled job state untouched when pi.sendMessage throws for a stale session", async () => {
        // Delivery failure cannot roll back settled state, even after the batch exhausts retries.
        const workDir = createTempWorkDir("notify-stale-send");
        let sends = 0;
        let failing = true;
        const session = await openSession(workDir, {
            sendMessage: () => {
                sends += 1;
                if (failing) throw new Error("stale extension context");
            },
        });

        try {
            const cases = [
                {
                    id: "state-completed",
                    outcome: { type: "completed", exitCode: 0 } as const,
                    status: "completed",
                    exitCode: 0,
                    error: undefined,
                },
                {
                    id: "state-failed",
                    outcome: { type: "failed", error: "boom", exitCode: 3 } as const,
                    status: "failed",
                    exitCode: 3,
                    error: "boom",
                },
                {
                    id: "state-killed",
                    outcome: { type: "killed", error: "manual" } as const,
                    status: "killed",
                    exitCode: undefined,
                    error: "manual",
                },
            ];

            for (const { id, outcome, status, exitCode, error } of cases) {
                startJob(id, "echo kept");
                shellManager.appendOutput(id, "kept\n");
                const before = Date.now();

                let settled = false;
                assert.doesNotThrow(() => {
                    settled = shellManager.settleJob(id, outcome);
                }, "a throwing sendMessage must not fail the settle");
                assert.equal(settled, true, "the settle must still be applied");

                const job = shellManager.getJob(id)!;
                assert.equal(job.status, status, "the settle outcome must be the job's status");
                assert.ok(job.finishedAt !== undefined && job.finishedAt >= before, `the finish must be stamped after the settle, got ${String(job.finishedAt)}`);
                assert.equal(job.lastActivityAt, job.finishedAt, "the finish must stay the last activity");
                assert.equal(job.exitCode, exitCode, "the settle must carry its exit code through");
                assert.equal(job.error, error, "the settle must carry its reason through");
                assert.equal(job.output.content, "kept\n", "a delivery failure must not roll the output back");
                assert.equal(job.output.totalLines, 1, "the retained tail must stay intact");
                assert.equal(job.output.totalBytes, Buffer.byteLength("kept\n"), "the byte count must stay intact");
            }

            await waitFor("the terminal batch to exhaust two retries", () => session.ui.notifyCalls.some((call) => call.message.includes("Permanently failed")));
            assert.equal(sends, 3, "one batch has one initial attempt and two retries");
            assert.equal(session.host.sendMessageCalls.length, 3, "every attempt must be recorded on the host");
            assert.ok(session.ui.notifyCalls.every((call) => call.type === "error"));
            assert.deepEqual(shellManager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 1,
                failedCount: 1,
                killedCount: 1,
            }, "every outcome must reach its own counter despite the throwing transport");

            failing = false;
            startJob("state-after-stale", "echo again");
            assert.equal(shellManager.settleJob("state-after-stale", { type: "completed", exitCode: 0 }), true, "a later settle must still be accepted");
            await waitFor("the later notification to be delivered", () => sends === 4);
            assert.equal(sends, 4, "later notifications continue after permanent failure");
        } finally {
            await session.host.emit("session_shutdown", session.ctx);
            removeTempWorkDir(workDir);
        }
    });

    it("stops notifying after the returned unsubscribe runs", async () => {
        const calls: SendMessageCall[] = [];
        const pi = {
            sendMessage: (message: SendMessageCall["message"], options?: SendMessageCall["options"]) => {
                calls.push({ message, options });
            },
        } as unknown as ExtensionAPI;

        const unsubscribe = registerBackgroundShellNotifications(pi);
        startJob("job-before", "echo before");
        shellManager.settleJob("job-before", { type: "completed", exitCode: 0 });
        await waitFor("the completion before unsubscribe", () => calls.length === 1);
        assert.equal(calls.length, 1, "the completed job must notify before the unsubscribe");

        unsubscribe();
        startJob("job-after", "echo after");
        shellManager.settleJob("job-after", { type: "completed", exitCode: 0 });

        assert.equal(calls.length, 1, "an unsubscribed listener must stay silent");
        assert.doesNotThrow(() => unsubscribe(), "unsubscribing twice must be harmless");
    });

    it("does not stack listeners across repeated session_start events", async () => {
        const workDir = createTempWorkDir("notify-restart-same");
        const host = registerExtension(workDir);
        const ctx = createFakeContext(workDir, { ui: createFakeUi() });
        try {
            // A session lifecycle can fire session_start again without a process restart; each one
            // must replace the previous listener instead of adding another notifier.
            for (let restart = 0; restart < 4; restart++) {
                await host.emit("session_start", ctx);
            }

            startJob("job-restart-1", "echo one");
            shellManager.settleJob("job-restart-1", { type: "completed", exitCode: 0 });
            await waitFor("the batched completion after restart", () => host.sendMessageCalls.length === 1);
            assert.equal(host.sendMessageCalls.length, 1, "one job must notify once regardless of restarts");

            for (let restart = 0; restart < 3; restart++) {
                await host.emit("session_start", ctx);
            }
            startJob("job-restart-2", "echo two");
            shellManager.settleJob("job-restart-2", { type: "completed", exitCode: 0 });

            await waitFor("the batched completion after restart", () => host.sendMessageCalls.length === 2);
            assert.equal(host.sendMessageCalls.length, 2, "the second job must add exactly one notification");
            assert.equal(
                host.sendMessageCalls.filter(
                    (call) => (call.message.details as { jobs: Array<{ shellJobId: string }> }).jobs.some((job) => job.shellJobId === "job-restart-2"),
                ).length,
                1,
                "the second job must not have been notified by a historical listener",
            );
        } finally {
            await host.emit("session_shutdown", ctx);
            removeTempWorkDir(workDir);
        }
    });

    it("keeps multiple near-simultaneous completions individually correct", async () => {
        // Batching must preserve every outcome and the output-to-job association.
        await withSession("notify-burst", async (session) => {
            startJob("burst-a", "echo a");
            startJob("burst-b", "exit 3");
            startJob("burst-c", "sleep 1");
            shellManager.appendOutput("burst-a", "a-out\n");
            shellManager.appendOutput("burst-b", "b-out\n");
            shellManager.appendOutput("burst-c", "c-out\n");

            assert.equal(shellManager.settleJob("burst-a", { type: "completed", exitCode: 0 }), true, "the completed settle must be accepted");
            assert.equal(
                shellManager.settleJob("burst-b", {
                    type: "failed",
                    error: "Background shell exited with code 3",
                    exitCode: 3,
                }),
                true,
                "the failed settle must be accepted",
            );
            assert.equal(shellManager.settleJob("burst-c", { type: "killed", error: "user" }), true, "the killed settle must be accepted");

            assert.deepEqual(shellManager.getAllJobsStatusStat(), {
                runningCount: 0,
                completedCount: 1,
                failedCount: 1,
                killedCount: 1,
            }, "the burst must move each counter exactly once");
            await waitFor("the batched burst notification", () => session.host.sendMessageCalls.length === 1);
            assert.equal(session.host.sendMessageCalls.length, 1, "near-simultaneous events form one batch");
            const call = session.host.sendMessageCalls[0]!;
            const jobs = (call.message.details as { jobs: Array<{ shellJobId: string; status: string; exitCode?: number }> }).jobs;
            assert.deepEqual(jobs, [
                { shellJobId: "burst-a", status: "completed", exitCode: 0 },
                { shellJobId: "burst-b", status: "failed", exitCode: 3 },
                { shellJobId: "burst-c", status: "killed", exitCode: undefined },
            ], "each job must retain its own metadata without loss or duplication");
            const sections = messageText(call).split("\n\n---\n\n");
            for (const [index, [id, status, output]] of [
                ["burst-a", "completed", "a-out"],
                ["burst-b", "failed", "b-out"],
                ["burst-c", "killed", "c-out"],
            ].entries()) {
                assert.ok(sections[index]!.startsWith(`Background shell ${id} ${status}.`));
                assert.ok(sections[index]!.endsWith(`Output:\n${output}\n`));
            }
        });
    });

    it("hands notifications over from an ended session to the next one", async () => {
        // Contract: the listener belongs to the live session, so a reload/restart followed by a
        // shutdown of the old session leaves exactly one notifier - the new session's.
        const firstDir = createTempWorkDir("notify-handover-first");
        const secondDir = createTempWorkDir("notify-handover-second");
        try {
            const first = registerExtension(firstDir);
            const firstCtx = createFakeContext(firstDir, { ui: createFakeUi() });
            await first.emit("session_start", firstCtx);
            await first.emit("session_shutdown", firstCtx);

            const second = registerExtension(secondDir);
            const secondCtx = createFakeContext(secondDir, { ui: createFakeUi() });
            await second.emit("session_start", secondCtx);

            startJob("job-handover", "echo hi");
            shellManager.settleJob("job-handover", { type: "completed", exitCode: 0 });

            assert.deepEqual(first.sendMessageCalls, [], "the ended session must not be notified");
            await waitFor("the live session notification", () => second.sendMessageCalls.length === 1);
            assert.equal(second.sendMessageCalls.length, 1, "the live session must be notified once");

            await second.emit("session_shutdown", secondCtx);
        } finally {
            removeTempWorkDir(firstDir);
            removeTempWorkDir(secondDir);
        }
    });
});
