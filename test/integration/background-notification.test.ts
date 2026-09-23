/**
 * Background shell notification contract.
 *
 * Every terminal job event (completed, failed, killed) sends exactly one follow-up custom message
 * to the session, so the agent learns about a detached shell it could no longer observe; the
 * non-terminal events (started, output, cleared) stay silent. The lifecycle is part of the
 * contract: the listener is installed per session and replaced on every session_start, removed on
 * session_shutdown - or by the unsubscribe the registration returns - so restarts never stack
 * listeners and one job can never notify twice.
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
    waitForJobSettled,
    type ExtensionSession,
    type SendMessageCall,
} from "../harness.ts";

/** Text of one captured `pi.sendMessage` call. */
function messageText(call: SendMessageCall): string {
    return typeof call.message.content === "string" ? call.message.content : "";
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

describe("pi-shell-view background notifications", () => {
    beforeEach(() => {
        shellManager.clearAllJobs();
    });

    afterEach(() => {
        shellManager.clearAllJobs();
    });

    it("sends one completion notification with the job metadata and the follow-up options", async () => {
        // Contract: the immediate tool result cannot report the outcome, so the settled job sends
        // one follow-up turn carrying the id, status, command, exit code and output, without ever
        // becoming a visible transcript row.
        await withSession("notify-completed", async (session) => {
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "echo notify-done",
                ctx: session.ctx,
                toolCallId: "call-notify-completed",
            });

            const settled = await waitForJobSettled(jobId);
            assert.equal(settled.status, "completed");
            assert.equal(session.host.sendMessageCalls.length, 1, "one terminal event must notify once");

            const call = session.host.sendMessageCalls[0]!;
            const text = messageText(call);

            assert.equal(call.message.customType, "background-shell-notification");
            assert.equal(call.message.display, false, "the notification must not enter the transcript");
            assert.equal(call.options?.triggerTurn, true, "the agent must get a turn to read it");
            assert.equal(call.options?.deliverAs, "followUp");
            assert.deepEqual(call.message.details, {
                shellJobId: jobId,
                status: "completed",
                exitCode: 0,
            });

            assert.ok(text.startsWith(`Background shell ${jobId} completed.`), text);
            assert.ok(text.includes("Command: echo notify-done"), text);
            assert.ok(text.includes("Exit code: 0"), text);
            assert.ok(text.endsWith(`Output:\n${settled.output.content}`), text);
            assert.ok(!text.includes("undefined"), "absent optional fields must be omitted, not printed");
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
            assert.equal(settled.status, "failed");
            assert.equal(session.host.sendMessageCalls.length, 1);

            const text = messageText(session.host.sendMessageCalls[0]!);

            assert.ok(text.startsWith(`Background shell ${jobId} failed.`), text);
            assert.ok(text.includes("Error: timeout:1"), text);
            assert.ok(!text.includes("Exit code:"), "a failed execution reports no process exit code");
            assert.ok(!text.includes("undefined"), text);
        });
    });

    it("notifies a killed job once, with the kill reason", async () => {
        await withSession("notify-killed", async (session) => {
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "sleep 5",
                ctx: session.ctx,
                toolCallId: "call-notify-killed",
            });

            assert.equal(shellManager.settleJob(jobId, { type: "killed", error: "manual kill" }), true);
            assert.equal(shellManager.getJob(jobId)?.controller.signal.aborted, true);

            assert.equal(session.host.sendMessageCalls.length, 1);
            const text = messageText(session.host.sendMessageCalls[0]!);

            assert.ok(text.startsWith(`Background shell ${jobId} killed.`), text);
            assert.ok(text.includes("Error: manual kill"), text);
            assert.ok(!text.includes("undefined"), text);
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
            assert.equal(settled.status, "failed");
            assert.equal(session.host.sendMessageCalls.length, 1);

            const text = messageText(session.host.sendMessageCalls[0]!);

            assert.ok(text.startsWith(`Background shell ${jobId} failed.`), text);
            assert.ok(text.includes("Exit code: 7"), text);
            assert.ok(text.includes("Error: Background shell exited with code 7"), text);
            assert.ok(text.endsWith("Output:\npartial\n"), text);
        });
    });

    it("stays silent for non-terminal events and the session's own clear", async () => {
        // Contract: only a settled job is worth a follow-up turn; started, output and cleared events
        // - including the clear session_start performs - must not wake the agent.
        await withSession("notify-silent", async (session) => {
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command: "sleep 1; printf 'late\\n'",
                ctx: session.ctx,
                toolCallId: "call-notify-silent",
            });

            shellManager.appendOutput(jobId, "");
            shellManager.clearAllJobs();

            // Give the aborted execution time to reject and reach its refused settle.
            await new Promise((resolve) => setTimeout(resolve, 300));

            assert.deepEqual(session.host.sendMessageCalls, []);
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
            assert.ok(path, "guard: the flood must have spilled");

            assert.equal(session.host.sendMessageCalls.length, 1);
            const text = messageText(session.host.sendMessageCalls[0]!);

            assert.ok(text.includes(`[Output truncated. Full output: ${path}]`), text);
            assert.ok(text.includes("L2499"), "the newest line must reach the agent");
            assert.ok(!text.includes("L0\n"), "the dropped head must not reach the agent");
            assert.ok(!text.includes("[object Object]"), "the structured output must be rendered");
            assert.ok(!text.includes("Showing last"), "the banner must not claim line numbers the counter cannot supply");
            assert.ok(text.length < full.length, "the reported text must stay bounded");

            rmSync(path, { force: true });
        });
    });

    it("sends exactly one notification per job even when settles repeat", async () => {
        await withSession("notify-once", async (session) => {
            startJob("job-once", "echo once");

            assert.equal(shellManager.settleJob("job-once", { type: "completed", exitCode: 0 }), true);
            assert.equal(shellManager.settleJob("job-once", { type: "failed", error: "late" }), false);

            assert.equal(session.host.sendMessageCalls.length, 1);
        });
    });

    it("stops notifying after the returned unsubscribe runs", () => {
        const calls: SendMessageCall[] = [];
        const pi = {
            sendMessage: (message: SendMessageCall["message"], options?: SendMessageCall["options"]) => {
                calls.push({ message, options });
            },
        } as unknown as ExtensionAPI;

        const unsubscribe = registerBackgroundShellNotifications(pi);
        startJob("job-before", "echo before");
        shellManager.settleJob("job-before", { type: "completed", exitCode: 0 });
        assert.equal(calls.length, 1);

        unsubscribe();
        startJob("job-after", "echo after");
        shellManager.settleJob("job-after", { type: "completed", exitCode: 0 });

        assert.equal(calls.length, 1, "an unsubscribed listener must stay silent");
        assert.doesNotThrow(() => unsubscribe(), "unsubscribing twice must be harmless");
    });

    it("does not stack listeners when session_start fires twice on one load", async () => {
        const workDir = createTempWorkDir("notify-restart-same");
        const host = registerExtension(workDir);
        const ctx = createFakeContext(workDir, { ui: createFakeUi() });
        try {
            await host.emit("session_start", ctx);
            await host.emit("session_start", ctx);

            startJob("job-restart", "echo hi");
            shellManager.settleJob("job-restart", { type: "completed", exitCode: 0 });

            assert.equal(host.sendMessageCalls.length, 1, "a repeated session_start must replace its listener");
        } finally {
            await host.emit("session_shutdown", ctx);
            removeTempWorkDir(workDir);
        }
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
            assert.equal(second.sendMessageCalls.length, 1, "the live session must be notified once");

            await second.emit("session_shutdown", secondCtx);
        } finally {
            removeTempWorkDir(firstDir);
            removeTempWorkDir(secondDir);
        }
    });
});
