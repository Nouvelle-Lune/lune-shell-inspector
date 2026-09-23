/**
 * Background execution contract of the registered `bash` tool.
 *
 * With `mode: "background"` the wrapper answers immediately with a `Background shell started ...`
 * result while `startBackgroundShell` runs the command through pi's local bash operations and
 * records it as a `ShellManager` job. These tests drive real commands through the registered tool
 * and assert the detached half: what the immediate result says, how the job is registered, how raw
 * output is appended while the command runs, and how the job settles - completed on exit code 0,
 * failed with its exit code and reason on any non-zero exit, and failed with the underlying reason
 * when the execution itself fails (timeout, missing working directory), with a settle racing an
 * explicit kill or a session teardown as a silent no-op. The foreground contract lives in
 * `test/integration/bash-delegation.test.ts`; the dock these jobs drive is covered by
 * `test/integration/extension-lifecycle.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

import { shellManager } from "../../src/shell/shell-manager.ts";
import { getFixture } from "../fixtures/long-running-scripts.ts";
import {
    createFakeContext,
    createTempWorkDir,
    openSession,
    readJobScreen,
    removeTempWorkDir,
    requireError,
    requireResult,
    resultText,
    runBashCommand,
    startBackgroundBashCommand,
    waitFor,
    waitForJobSettled,
    type ExtensionSession,
} from "../harness.ts";

describe("pi-shell-view background bash", () => {
    let workDir: string;
    let session: ExtensionSession;

    beforeEach(async () => {
        shellManager.clearAllJobs();
        workDir = createTempWorkDir("background");
        session = await openSession(workDir);
    });

    afterEach(async () => {
        await session.host.emit("session_shutdown", session.ctx);
        removeTempWorkDir(workDir);
    });

    it("returns immediately with the started result and the job details", async () => {
        // Contract: the call must not wait for the command - it answers with a text result naming the
        // tool call and the command plus details pointing at the job, while the shell keeps running.
        const command = "sleep 2";
        const { run, jobId } = await startBackgroundBashCommand(session.tool, {
            command,
            ctx: session.ctx,
            toolCallId: "call-immediate",
        });

        assert.equal(run.failed, false, `expected the call to succeed: ${run.error?.message ?? ""}`);
        assert.equal(jobId, "call-immediate");
        assert.equal(resultText(requireResult(run)), `Background shell started call-immediate: ${command}`);
        assert.deepEqual(requireResult(run).details, { shellJobId: "call-immediate", background: true });
        assert.deepEqual(run.updates, [], "a background call must not stream to its caller");
        assert.ok(run.durationMs < 1000, `the call must return while the 2s sleep runs, took ${run.durationMs}ms`);

        const running = shellManager.getJob("call-immediate");
        assert.ok(running, "expected the call to be recorded as a job");
        assert.equal(running.status, "running", "the command must still be running after the call returned");
        assert.equal(running.output.content, "", "no output has been produced yet");

        const settled = await waitForJobSettled("call-immediate");
        assert.equal(settled.status, "completed");
        assert.equal(settled.exitCode, 0);
        assert.equal(settled.output.content, "");
    });

    it("registers the job with the call id, the command, ctx.cwd and a live controller", async () => {
        // Contract: the tool call id is the job id and ctx.cwd is the job cwd, so a dock/inspector
        // entry can be traced back to the call that produced it; the job owns the AbortController the
        // runner can fire.
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "echo job-fields",
            ctx: session.ctx,
            toolCallId: "call-fields",
        });
        const job = shellManager.getJob(jobId);
        assert.ok(job, "expected the started job");

        assert.equal(job.id, "call-fields");
        assert.equal(job.command, "echo job-fields");
        assert.equal(job.cwd, session.ctx.cwd);
        assert.equal(job.status, "running");
        assert.equal(job.controller.signal.aborted, false, "a running job's controller is not aborted");

        await waitForJobSettled("call-fields");
    });

    it("appends output to the job while the command is still running", async () => {
        // Contract: data events stream into the job through appendOutput, so the dock and the
        // inspector see the same text growing while the tool call has long returned.
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "printf 'first\\n'; sleep 0.5; printf 'second\\n'; sleep 0.5; printf 'third\\n'",
            ctx: session.ctx,
            toolCallId: "call-streaming",
        });

        await waitFor("the first chunk to reach the job", () => (shellManager.getJob(jobId)?.output.content ?? "").includes("first"));

        const streaming = shellManager.getJob(jobId);
        assert.ok(streaming);
        assert.equal(streaming.status, "running", "the job must still be running after its first chunk");
        assert.equal(streaming.output.content, "first\n", "no later chunk may have arrived yet");

        const settled = await waitForJobSettled(jobId);
        assert.equal(settled.status, "completed");
        assert.equal(settled.output.content, "first\nsecond\nthird\n");
        assert.ok(settled.lastActivityAt >= settled.startedAt);
    });

    it("keeps the streamed bytes as they arrive: carriage returns and ANSI escapes included", async () => {
        // Contract: the background runner appends the raw chunks of pi's local bash operations, so
        // unlike the built-in foreground result (which sanitizes the display text) the job output
        // contains the original carriage returns and escape sequences.
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "printf 'plain\\n'; printf 'cr\\rback\\n'; printf 'colored: \\033[31mred\\033[0m\\n'",
            ctx: session.ctx,
            toolCallId: "call-raw",
        });

        const settled = await waitForJobSettled(jobId);

        assert.equal(settled.status, "completed");
        assert.equal(settled.output.content, "plain\ncr\rback\ncolored: \u001b[31mred\u001b[0m\n");
    });

    it("shows the progress fixture's screen instead of its redraws", async () => {
        // Contract: the job keeps the raw stream - every carriage-return redraw - while readers get
        // the executed screen, so a progress bar is one line and no control byte reaches a renderer.
        const fixture = getFixture("progress");
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: fixture.command,
            ctx: session.ctx,
            toolCallId: "call-progress-screen",
        });

        const settled = await waitForJobSettled(jobId);
        const screen = await readJobScreen(jobId);

        assert.ok(settled.output.content.includes("\r"), "the raw output must still carry every redraw");
        assert.deepEqual(screen, ["progress: 100%", "progress: done"]);
    });

    it("shows the spinner fixture's erased line as its final screen line", async () => {
        // Contract: erase-line (CSI K), SGR colour and carriage returns are executed, not displayed,
        // so only the line the fixture finished with is left on the screen.
        const fixture = getFixture("spinner");
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: fixture.command,
            ctx: session.ctx,
            toolCallId: "call-spinner-screen",
        });

        const settled = await waitForJobSettled(jobId);
        const screen = await readJobScreen(jobId);

        assert.ok(settled.output.content.includes("\u001b[2K"), "the raw output must still carry the erase-line sequence");
        assert.deepEqual(screen, ["spinner: done"]);
    });

    it("shows the vt-shapes fixture exactly as the terminal executed it", async () => {
        // Contract: one real stream through every shape the inspector has to survive - carriage-return
        // redraws, erase-line, cursor-left/right/up, SGR colour and bold, a CSI split across chunks, a
        // carriage return split across chunks, CJK/emoji/wide cells and a line wider than the emulator.
        // The expected lines are screen results: the cursor-up overwrite and the erased scratch row
        // only exist after the emulator ran the stream.
        const fixture = getFixture("vt-shapes");
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: fixture.command,
            ctx: session.ctx,
            toolCallId: "call-vt-shapes",
        });

        await waitForJobSettled(jobId, 30_000);
        const screen = await readJobScreen(jobId);

        assert.deepEqual(screen, [
            "progress 3%",
            "bar",
            "cursor-left : abcXYf",
            "cursor-right: AB   XY",
            "cursor-up   : hit!",
            "red and bold",
            "chunked red",
            "progress 2%",
            "日本語の進捗テスト: 五割 🚀",
            `wide: ${"漢".repeat(70)}`,
            "vt-shapes: done",
        ]);
    });

    it("spills the complete output of a flood while the screen and the reported tail stay bounded", async () => {
        // Contract: the background job applies the same tail retention as the built-in tool - the
        // in-memory tail is bounded and the complete ~200KB stream goes to `fullOutputPath`, while
        // the model-facing report points at that file instead of carrying the whole flood.
        const fixture = getFixture("flood");
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: fixture.command,
            ctx: session.ctx,
            toolCallId: "call-flood",
        });

        const settled = await waitForJobSettled(jobId, 20_000);

        assert.equal(settled.status, "completed");
        assert.equal(settled.output.truncated, true, "the flood must spill to a file");
        assert.ok(
            settled.output.totalBytes > 200 * 1024,
            `expected the complete ~200KB flood, got ${settled.output.totalBytes} bytes`,
        );
        assert.ok(settled.output.content.includes("flood line 05000"), "the last flood line must stay in the tail");

        const fullOutputPath = settled.output.fullOutputPath;
        assert.ok(fullOutputPath, "a spilled job must expose the file with the complete output");
        const persisted = readFileSync(fullOutputPath, "utf8");
        assert.ok(persisted.includes("flood line 00001"), "the spill file must keep the first line");
        assert.ok(persisted.includes("flood line 05000"), "the spill file must keep the last line");

        const reported = shellManager.getJobOutput(jobId);
        assert.equal(reported.split("\n").at(0), `[Output truncated. Full output: ${fullOutputPath}]`);
        assert.ok(reported.includes("flood line 05000"));
        assert.ok(reported.length < persisted.length, "the reported text must stay bounded");

        // The screen converts the same run in arrival order (fifty streamed batches of a hundred
        // lines), so the newest line is last and nothing was reordered or lost on the way - while its
        // own history is bounded by the emulator's scrollback, like the retained tail.
        const screen = await readJobScreen(jobId);
        assert.equal(screen.at(-1), `flood line 05000 ${"x".repeat(24)}`);
        assert.ok(
            screen.length <= DEFAULT_MAX_LINES + 50,
            `the screen history must stay bounded, kept ${screen.length}`,
        );
        assert.ok(!screen.includes(`flood line 00001 ${"x".repeat(24)}`), "the oldest lines must have scrolled off");

        rmSync(fullOutputPath, { force: true });
    });

    it("fails a non-zero exit with its exit code and reason", async () => {
        // Contract: for a background shell "finished" is not "succeeded" - only exit code 0 settles
        // the job as completed; any other code fails it, carrying both the code and the runner's
        // reason, while the output produced before the exit is kept.
        const { run, jobId } = await startBackgroundBashCommand(session.tool, {
            command: "printf 'before failure\\n'; exit 3",
            ctx: session.ctx,
            toolCallId: "call-exit-code",
        });
        assert.equal(run.failed, false, "the immediate result must not carry the later exit code");

        const settled = await waitForJobSettled(jobId);

        assert.equal(settled.status, "failed");
        assert.equal(settled.exitCode, 3);
        assert.equal(settled.error, "Background shell exited with code 3");
        assert.equal(settled.output.content, "before failure\n");
        assert.equal(settled.controller.signal.aborted, false, "a non-zero exit is not a caller kill");
    });

    it("classifies every non-zero exit as a failure, however the process ended", async () => {
        // Contract: a normal `exit N` and a signal death (reported as 128+N) both fail the job; only
        // the code in the reason changes.
        const cases: readonly [number, string][] = [
            [1, "exit 1"],
            [42, "printf 'partial\\n'; exit 42"],
            [137, "kill -9 $$"],
        ];

        for (const [code, command] of cases) {
            const { jobId } = await startBackgroundBashCommand(session.tool, {
                command,
                ctx: session.ctx,
                toolCallId: `call-exit-${code}`,
            });

            const settled = await waitForJobSettled(jobId);

            assert.equal(settled.status, "failed", `exit ${code} must fail the job`);
            assert.equal(settled.exitCode, code);
            assert.equal(settled.error, `Background shell exited with code ${code}`);
            assert.equal(
                shellManager.getJob(jobId)?.controller.signal.aborted,
                false,
                `exit ${code} is not a kill`,
            );
        }
    });

    it("fails a timed-out job and records the timeout reason", async () => {
        // Contract: a timeout makes the execution itself fail, so the job is a failure with the
        // runner's reason, and it leaves `running` long before the command would end. The job's
        // controller was never aborted, so this is not a kill.
        const startedAt = Date.now();
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "sleep 5",
            timeout: 1,
            ctx: session.ctx,
            toolCallId: "call-timeout",
        });

        const settled = await waitForJobSettled(jobId);

        assert.equal(settled.status, "failed");
        assert.equal(settled.error, "timeout:1");
        assert.equal(settled.exitCode, undefined, "a failed execution has no process exit code");
        assert.equal(settled.controller.signal.aborted, false, "a timeout is not a caller kill");
        assert.ok(Date.now() - startedAt < 4000, "the timeout must cut the 5s sleep short");
    });

    it("fails a job whose working directory does not exist", async () => {
        // Contract: the execution fails before a process exists, and the job is classified as a
        // failure with the runner's error message rather than completing silently.
        const missingDir = "/pi-shell-view/does-not-exist";
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "echo never",
            ctx: createFakeContext(missingDir),
            toolCallId: "call-missing-cwd",
        });

        const settled = await waitForJobSettled(jobId);

        assert.equal(settled.cwd, missingDir);
        assert.equal(settled.status, "failed");
        assert.equal(settled.controller.signal.aborted, false);
        assert.ok(
            settled.error?.includes(`Working directory does not exist: ${missingDir}`),
            `expected the runner's cwd error, got ${JSON.stringify(settled.error)}`,
        );
    });

    it("tracks parallel background jobs independently", async () => {
        // Contract: pi can start sibling background calls, so the manager keys each job by tool call
        // id and keeps its own command, output and exit code.
        const slow = await startBackgroundBashCommand(session.tool, {
            command: "sleep 0.4; printf 'slow\\n'",
            ctx: session.ctx,
            toolCallId: "call-slow",
        });
        const fast = await startBackgroundBashCommand(session.tool, {
            command: "printf 'fast\\n'; exit 2",
            ctx: session.ctx,
            toolCallId: "call-fast",
        });

        const fastSettled = await waitForJobSettled(fast.jobId);
        const slowSettled = await waitForJobSettled(slow.jobId);

        assert.equal(fastSettled.status, "failed", "a non-zero exit must fail the job");
        assert.equal(fastSettled.error, "Background shell exited with code 2");
        assert.equal(fastSettled.output.content, "fast\n");
        assert.equal(fastSettled.exitCode, 2);
        assert.equal(slowSettled.status, "completed");
        assert.equal(slowSettled.output.content, "slow\n");
        assert.equal(slowSettled.exitCode, 0);
        assert.equal(shellManager.getRunningJobsList().length, 0, "both jobs must be settled");
    });

    it("rejects a tool call id that is already running", async () => {
        // Contract: pi tool call ids are unique, so reusing one while it runs is a caller bug; the
        // manager refuses the second start before any process is spawned and the first job survives.
        const first = await startBackgroundBashCommand(session.tool, {
            command: "sleep 1",
            ctx: session.ctx,
            toolCallId: "call-duplicate",
        });

        const duplicate = await runBashCommand(session.tool, {
            command: "echo duplicate",
            mode: "background",
            ctx: session.ctx,
            toolCallId: "call-duplicate",
        });

        assert.match(requireError(duplicate).message, /Shell job already exists: call-duplicate/);
        assert.equal(shellManager.getJob("call-duplicate")?.status, "running", "the original job must survive");

        const settled = await waitForJobSettled(first.jobId);
        assert.equal(settled.status, "completed");
        assert.equal(settled.output.content, "", "the rejected duplicate must not have written to the job");
    });

    it("ignores a settle that races the execution's own rejection", async () => {
        // Contract: an explicit kill settles the job first; when the aborted execution then rejects,
        // the runner's settle must be a no-op (idempotent), not an unhandled rejection. A detached
        // rejection here would fail this test through node:test's handler.
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "sleep 1",
            ctx: session.ctx,
            toolCallId: "call-kill-race",
        });

        assert.equal(shellManager.settleJob(jobId, { type: "killed", error: "manual kill" }), true);

        // Give the aborted execution time to reject and reach its settle call.
        await new Promise((resolve) => setTimeout(resolve, 500));

        const job = shellManager.getJob(jobId);
        assert.equal(job?.status, "killed", "the explicit kill must stay the outcome");
        assert.equal(job?.error, "manual kill");
    });

    it("ignores the execution's settle after the session dropped the job", async () => {
        // Contract: session teardown aborts a running job and clears it; when the aborted execution
        // then rejects, the runner's settle must be a no-op instead of an unhandled rejection or a
        // resurrected job.
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "sleep 1",
            ctx: session.ctx,
            toolCallId: "call-clear-race",
        });

        shellManager.clearAllJobs();

        // Give the aborted execution time to reject and reach its settle call.
        await new Promise((resolve) => setTimeout(resolve, 500));

        assert.equal(shellManager.getJob(jobId), undefined, "the cleared job must stay gone");
        assert.deepEqual(shellManager.getAllJobsList(), [], "the late settle must not resurrect the job");
        assert.deepEqual(
            shellManager.getAllJobsStatusStat(),
            { runningCount: 0, completedCount: 0, failedCount: 0, killedCount: 0 },
            "a refused settle must not move a counter",
        );
        assert.equal(
            shellManager.settleJob(jobId, { type: "completed", exitCode: 0 }),
            false,
            "a settle for a dropped job must be refused directly, too",
        );
        assert.deepEqual(session.host.sendMessageCalls, [], "a dropped job must not notify");
    });

    it("refuses a chunk that arrives after teardown instead of resurrecting the job", async () => {
        // Race: the real backend can deliver a buffered onData chunk after clearAllJobs() aborted
        // the process and dropped the job. appendOutput() is running-only and refuses the unknown
        // id loudly: a silent drop would hide the race, and a recreated job would show a shell that
        // no longer exists.
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "sleep 5",
            ctx: session.ctx,
            toolCallId: "call-teardown-chunk",
        });

        shellManager.clearAllJobs();

        assert.throws(
            () => shellManager.appendOutput(jobId, "buffered chunk"),
            /Unknown shell job: call-teardown-chunk/,
        );
        assert.equal(shellManager.getJob(jobId), undefined, "the cleared job must stay gone");
        assert.deepEqual(session.host.sendMessageCalls, [], "a refused chunk must not notify");
    });
});
