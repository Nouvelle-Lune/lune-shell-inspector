/**
 * Inspection contract of the registered `background_shell` tool.
 *
 * A background `bash` call returns before its command printed anything and its transcript row is
 * suppressed, so this tool is the only pull path to a detached job: it lists every shell the
 * manager owns or reports the requested ones. Reported output is the job's terminal screen - the
 * same text `/shell` shows, with the raw VT stream already executed - and only for shells whose
 * entry asked for it. These tests drive the registered definition against real jobs started through
 * the registered `bash` tool; the job lifecycle itself is covered by
 * `test/integration/background-bash.test.ts` and the schema by
 * `test/integration/extension-registration.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { shellManager } from "../../src/shell/shell-manager.ts";
import {
    createTempWorkDir,
    loadRegisteredTool,
    openSession,
    removeTempWorkDir,
    resultText,
    startBackgroundBashCommand,
    waitForJobSettled,
    type BashToolDefinition,
    type BashToolResult,
    type ExtensionSession,
} from "../harness.ts";

/** One entry of the tool's `jobs` array. */
interface JobQuery {
    jobID: string;
    includeOutput?: boolean;
}

/** Arguments the tool accepts; an omitted `jobs` means "list every shell". */
interface BackgroundShellParams {
    jobs?: JobQuery[];
}

/** Execute signature of the registered tool; only the params and the result are read. */
type BackgroundShellExecute = (
    toolCallId: string,
    params: BackgroundShellParams,
    signal: undefined,
    onUpdate: undefined,
    ctx: undefined,
) => Promise<BashToolResult>;

/** Call the tool the way pi does and return the text it answers with. */
async function inspect(
    tool: BashToolDefinition,
    params: BackgroundShellParams = {},
): Promise<string> {
    const execute = tool.execute as unknown as BackgroundShellExecute;
    return resultText(await execute("call-inspect", params, undefined, undefined, undefined));
}

describe("lune-shell-inspector background_shell invocation", () => {
    let workDir: string;
    let session: ExtensionSession;
    let inspector: BashToolDefinition;

    beforeEach(async () => {
        shellManager.clearAllJobs();
        workDir = createTempWorkDir("background-shell");
        session = await openSession(workDir);
        inspector = loadRegisteredTool(workDir, "background_shell");
    });

    afterEach(async () => {
        // Session teardown aborts the jobs the tests leave running.
        await session.host.emit("session_shutdown", session.ctx);
        removeTempWorkDir(workDir);
    });

    it("lists nothing before any background shell was started", async () => {
        // Contract: an empty manager is reported as prose, not as an empty string that the model
        // would have to interpret; an explicit empty `jobs` array means the same as omitting it.
        assert.equal(await inspect(inspector), "No background shells.");
        assert.equal(await inspect(inspector, { jobs: [] }), "No background shells.");
    });

    it("lists every job in insertion order with its id, status and command", async () => {
        // Contract: the list is the dock's job set - running jobs included, since "still running" is
        // exactly what the model asks about before the completion notification arrives.
        const completed = await startBackgroundBashCommand(session.tool, {
            command: "echo list-done",
            ctx: session.ctx,
            toolCallId: "call-list-completed",
        });
        await waitForJobSettled(completed.jobId);
        await startBackgroundBashCommand(session.tool, {
            command: "sleep 30",
            ctx: session.ctx,
            toolCallId: "call-list-running",
        });

        const text = await inspect(inspector);
        assert.equal(
            text,
            [
                "call-list-completed: completed - echo list-done",
                "call-list-running: running - sleep 30",
            ].join("\n"),
        );
        assert.equal(
            await inspect(inspector, { jobs: [] }),
            text,
            "omitting jobs and passing an empty array must list the same shells",
        );
    });

    it("reports the status line without output unless the entry asks for it", async () => {
        // Contract: reading output is opt-in, so a status check stays cheap and the output of an
        // unrequested shell never enters the model's context.
        const command = "printf 'secret-payload\\n'";
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command,
            ctx: session.ctx,
            toolCallId: "call-status-only",
        });
        await waitForJobSettled(jobId);

        const text = await inspect(inspector, { jobs: [{ jobID: jobId }] });
        assert.equal(text, `call-status-only: completed - ${command}`);
        assert.equal(
            text.split("\n").length,
            1,
            "a block without includeOutput must stay a single status line",
        );
    });

    it("reports the delivered output as the job's terminal screen", async () => {
        // Contract: readers get the executed screen, not the raw stream - the redraw before the
        // carriage return is overwritten and no control byte reaches the model. Reading right after
        // the job settled also proves the tool flushes xterm's write queue before it reads.
        const command = "printf 'progress 10%%\\rprogress 90%%\\nvt-done\\n'";
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command,
            ctx: session.ctx,
            toolCallId: "call-screen",
        });
        const settled = await waitForJobSettled(jobId);
        assert.ok(settled.output.content.includes("\r"), "guard: the raw stream must carry the redraw");

        const text = await inspect(inspector, { jobs: [{ jobID: jobId, includeOutput: true }] });
        const [statusLine, ...outputLines] = text.split("\n");
        assert.equal(statusLine, `call-screen: completed - ${command}`);
        assert.deepEqual(outputLines, ["progress 90%", "vt-done"]);
        assert.ok(!text.includes("\r"), "the raw VT stream must not reach the model");
    });

    it("marks a shell that has not printed anything yet", async () => {
        // Contract: an empty screen is reported explicitly, so "requested output" is never confused
        // with "output not requested" and the model does not read silence as a consumed stream.
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "sleep 30",
            ctx: session.ctx,
            toolCallId: "call-silent",
        });

        const text = await inspect(inspector, { jobs: [{ jobID: jobId, includeOutput: true }] });
        assert.equal(text, "call-silent: running - sleep 30\n(no output yet)");
    });

    it("answers one block per requested shell and isolates unknown ids", async () => {
        // Contract: a stale id answers inline instead of throwing, and every requested shell keeps
        // its own block in the order asked for - one bad id must not fail the whole query.
        const { jobId } = await startBackgroundBashCommand(session.tool, {
            command: "echo mixed-known",
            ctx: session.ctx,
            toolCallId: "call-mixed",
        });
        await waitForJobSettled(jobId);

        const text = await inspect(inspector, {
            jobs: [
                { jobID: "call-missing" },
                { jobID: jobId },
                { jobID: "call-missing-with-output", includeOutput: true },
            ],
        });

        assert.equal(
            text,
            [
                "Unknown background shell: call-missing",
                "call-mixed: completed - echo mixed-known",
                "Unknown background shell: call-missing-with-output",
            ].join("\n\n"),
        );
    });
});
