/**
 * Delegation contract of the registered `bash` tool.
 *
 * The extension is an observer: it copies the built-in definition, then hands every call through to
 * pi's built-in bash implementation unchanged. These tests drive real commands through the
 * registered tool and assert what the caller receives - the result object, the streamed `onUpdate`
 * snapshots and the thrown errors - plus the working directory the command really runs in. The shell
 * job bookkeeping that runs around the call is covered by
 * `test/integration/extension-lifecycle.test.ts`.
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import {
    createBuiltInBash,
    createFakeContext,
    createTempWorkDir,
    openSession,
    removeTempWorkDir,
    requireError,
    requireResult,
    resultText,
    runBashCommand,
    type ExtensionSession,
} from "../harness.ts";

describe("pi-shell-view bash delegation", () => {
    let workDir: string;
    let session: ExtensionSession;

    before(async () => {
        workDir = createTempWorkDir("delegation");
        session = await openSession(workDir);
    });

    after(async () => {
        await session.host.emit("session_shutdown", session.ctx);
        removeTempWorkDir(workDir);
    });

    it("returns exactly what a direct call to the built-in bash tool returns", async () => {
        // Contract: the call is delegated unchanged, so the result object (content blocks and details)
        // equals the result of the same command run through createBashTool(cwd) directly.
        const command = "printf 'alpha\\nbeta\\n'";
        const delegated = await runBashCommand(session.tool, { command, ctx: session.ctx, toolCallId: "call-passthrough" });
        const reference = await runBashCommand(createBuiltInBash(workDir), { command, ctx: null });

        assert.equal(reference.failed, false, `the reference call must succeed: ${reference.error?.message ?? ""}`);
        assert.deepEqual(delegated.result, reference.result);
        assert.equal(resultText(requireResult(delegated)), "alpha\nbeta\n");
        assert.equal(requireResult(delegated).details, undefined, "an untruncated result carries no details");
    });

    it("runs the command in ctx.cwd", async () => {
        // Contract: every call creates the built-in tool for ctx.cwd, so execution follows the
        // directory pi reports for the call even though the definition was loaded elsewhere.
        const otherDir = createTempWorkDir("delegation-other");
        try {
            const inContext = await runBashCommand(session.tool, {
                command: "pwd -P",
                ctx: createFakeContext(otherDir),
                toolCallId: "call-cwd-context",
            });
            assert.equal(resultText(requireResult(inContext)).trim(), realpathSync(otherDir));

            const inWorkDir = await runBashCommand(session.tool, {
                command: "pwd -P",
                ctx: session.ctx,
                toolCallId: "call-cwd-session",
            });
            assert.equal(resultText(requireResult(inWorkDir)).trim(), realpathSync(workDir));
        } finally {
            removeTempWorkDir(otherDir);
        }
    });

    it("applies params.timeout so a command that outlives it fails as timed out", async () => {
        // Contract: params.timeout is forwarded to the built-in tool, which kills the command and
        // reports "Command timed out after N seconds" instead of waiting for it.
        const run = await runBashCommand(session.tool, {
            command: "sleep 5",
            timeout: 1,
            ctx: session.ctx,
            toolCallId: "call-timeout",
        });
        const error = requireError(run);

        assert.equal(error.message, "Command timed out after 1 seconds");
        assert.ok(run.durationMs < 4000, `the timeout must cut the 5s sleep short, took ${run.durationMs}ms`);
    });

    it("passes a timeout that is never reached through without changing the result", async () => {
        // Contract: a timeout larger than the command runtime leaves the delegated execution unchanged.
        const run = await runBashCommand(session.tool, {
            command: "echo ok",
            timeout: 30,
            ctx: session.ctx,
            toolCallId: "call-timeout-idle",
        });

        assert.equal(resultText(requireResult(run)), "ok\n");
    });

    it("forwards the abort signal so a cancelled call fails as aborted", async () => {
        // Contract: the abort signal is one of the four forwarded arguments, so cancelling the call
        // kills the command and surfaces the built-in "Command aborted" error.
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 200);
        try {
            const run = await runBashCommand(session.tool, {
                command: "sleep 5",
                signal: controller.signal,
                ctx: session.ctx,
                toolCallId: "call-abort",
            });
            const error = requireError(run);

            assert.equal(error.message, "Command aborted");
            assert.ok(run.durationMs < 4000, `the abort must cut the 5s sleep short, took ${run.durationMs}ms`);
        } finally {
            clearTimeout(abortTimer);
        }
    });

    it("streams the built-in onUpdate payloads to the caller in order", async () => {
        // Contract: the wrapper forwards every snapshot to the caller's onUpdate after recording it,
        // so the caller sees the same cumulative snapshots the built-in tool produces.
        const run = await runBashCommand(session.tool, {
            command: "printf 'one\\n'; sleep 0.3; printf 'two\\n'; sleep 0.3; printf 'three\\n'",
            ctx: session.ctx,
            toolCallId: "call-stream",
        });

        assert.equal(run.failed, false, `expected the call to succeed: ${run.error?.message ?? ""}`);
        assert.ok(run.updates.length > 0, "expected at least one streamed snapshot");

        let previous = "";
        for (const update of run.updates) {
            const snapshot = resultText(update);
            assert.ok(snapshot.length >= previous.length, `a snapshot shrank: ${snapshot.length} < ${previous.length}`);
            previous = snapshot;
        }

        const lastSnapshot = run.updates.at(-1);
        assert.ok(lastSnapshot, "expected a last snapshot");
        assert.ok(
            resultText(requireResult(run)).startsWith(resultText(lastSnapshot)),
            "the reported text must extend the last streamed snapshot",
        );
        assert.equal(resultText(requireResult(run)), "one\ntwo\nthree\n");
    });
});
