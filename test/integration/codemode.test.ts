/**
 * What a codemode script receives from the extension's tools.
 *
 * codemode hands a script the `structuredContent` of a call whose tool declares an `outputSchema`,
 * and the tool's text otherwise, so that pair is what decides whether a script reads a field or a
 * string. These tests pin it on the definitions the extension registers: the bash wrapper declares
 * the built-in bash result unioned with its own background start shape and answers both modes with
 * matching `structuredContent`, while `background_shell` and `kill_background_shell` stay text-only.
 * Execution is covered by `test/integration/bash-delegation.test.ts` (foreground) and
 * `test/integration/background-bash.test.ts` (background), the declarations by
 * `test/integration/extension-registration.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { shellManager } from "../../src/shell/shell-manager.ts";
import {
    createTempWorkDir,
    loadRegisteredTool,
    openSession,
    removeTempWorkDir,
    requireResult,
    resultText,
    runBackgroundBashCommand,
    runBashCommand,
    type BashToolDefinition,
    type BashToolResult,
    type ExtensionSession,
} from "../harness.ts";

/** Execute signature shared by the tools this file drives; only params and result are read. */
type ToolExecute = (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: undefined,
) => Promise<BashToolResult>;

/** Run one of the extension's non-bash tools the way pi does and return its result. */
function invokeTool(tool: BashToolDefinition, params: Record<string, unknown> = {}): Promise<BashToolResult> {
    const execute = tool.execute as unknown as ToolExecute;
    return execute("call-codemode-inspect", params, undefined, undefined, undefined);
}

/** `structuredContent` as the object a codemode script reads fields from. */
function structuredContent(result: BashToolResult): Record<string, unknown> {
    const structured = result.structuredContent;
    assert.notEqual(structured, undefined, "the tool must answer with structuredContent");
    return structured as Record<string, unknown>;
}

describe("lune-shell-inspector under codemode", () => {
    let workDir: string;
    let session: ExtensionSession;
    let outputSchema: TSchema;

    beforeEach(async () => {
        shellManager.clearAllJobs();
        workDir = createTempWorkDir("codemode");
        session = await openSession(workDir);
        const bash = loadRegisteredTool(workDir, "bash");
        assert.ok(bash.outputSchema, "expected the bash wrapper to declare an output schema");
        outputSchema = bash.outputSchema;
    });

    afterEach(async () => {
        // Session teardown aborts the jobs the tests leave running.
        await session.host.emit("session_shutdown", session.ctx);
        removeTempWorkDir(workDir);
    });

    it("declares an output schema accepting both bash result shapes", () => {
        // Contract: the declared schema is the built-in bash result unioned with the background start
        // shape, because codemode's resolver only reaches a script through a schema that accepts the
        // value the call answered with - including the built-in optional path on truncated output.
        const foreground = { output: "x\n", truncated: false, exit_code: 0, wall_time_seconds: 0.1 };

        assert.equal(Value.Check(outputSchema, foreground), true, "a foreground result must be accepted");
        assert.equal(
            Value.Check(outputSchema, { ...foreground, full_output_path: "/tmp/full" }),
            true,
            "the built-in full_output_path must stay accepted",
        );
        assert.equal(
            Value.Check(outputSchema, { background: true, shell_job_id: "call-1", command: "echo hi" }),
            true,
            "a background start result must be accepted",
        );
        assert.equal(
            Value.Check(outputSchema, { output: "x\n", truncated: false, wall_time_seconds: 0.1 }),
            false,
            "the foreground member must keep the built-in required fields",
        );
        assert.equal(
            Value.Check(outputSchema, { background: true, command: "echo hi" }),
            false,
            "the background member must keep requiring its job id",
        );
    });

    it("answers a background call with the structured job start", async () => {
        // Contract: the immediate background answer carries `{ background, shellJobId, command }` as
        // structuredContent, so a script reads the job id as a field instead of parsing it out of the
        // text - which keeps reporting the same id and command for readers that only see text.
        const command = "printf 'bg\\n'";
        const { run } = await runBackgroundBashCommand(session.tool, {
            command,
            ctx: session.ctx,
            toolCallId: "call-codemode-bg",
        });
        const result = requireResult(run);

        assert.deepEqual(structuredContent(result), {
            background: true,
            shell_job_id: "call-codemode-bg",
            command,
        });
        assert.equal(resultText(result), `Background shell started with ID call-codemode-bg: ${command}`);
        assert.equal(
            Value.Check(outputSchema, structuredContent(result)),
            true,
            "the declared schema must accept what the call answered with",
        );
    });

    it("keeps the built-in structured result for a foreground call", async () => {
        // Contract: a foreground call resolves to the built-in bash structuredContent, so a script
        // reads `output` and `exit_code` fields instead of the model-facing text.
        const run = await runBashCommand(session.tool, { command: "printf 'hello\\n'", ctx: session.ctx });
        const structured = structuredContent(requireResult(run));

        assert.equal(structured.output, "hello\n");
        assert.equal(structured.truncated, false);
        assert.equal(structured.exit_code, 0);
        assert.equal(typeof structured.wall_time_seconds, "number");
        assert.equal("full_output_path" in structured, false, "an untruncated result must not carry a path");
        assert.equal(Value.Check(outputSchema, structured), true, "the declared schema must accept it");
    });

    it("still resolves a failed foreground call to its structured result", async () => {
        // Contract: pi reports a non-zero exit as an error result, but codemode returns a declared
        // structuredContent before applying its error path, so the script receives the exit code
        // instead of a rejected call.
        const run = await runBashCommand(session.tool, { command: "printf 'boom\\n'; exit 7", ctx: session.ctx });
        const result = requireResult(run);

        assert.equal(result.isError, true, "the built-in failure must stay flagged as an error result");
        const structured = structuredContent(result);
        assert.equal(structured.exit_code, 7);
        assert.match(String(structured.output), /boom/);
        assert.equal(Value.Check(outputSchema, structured), true, "the declared schema must accept it");
    });

    it("leaves the text-only tools without an output schema", async () => {
        // Contract: `background_shell` and `kill_background_shell` answer with text only and declare
        // no schema, so a script gets that text and is never promised a structure they do not send.
        const inspector = loadRegisteredTool(workDir, "background_shell");

        assert.equal(inspector.outputSchema, undefined, "the inspector must declare no output schema");
        assert.equal(
            loadRegisteredTool(workDir, "kill_background_shell").outputSchema,
            undefined,
            "the kill tool must declare no output schema",
        );

        const result = await invokeTool(inspector);
        assert.equal(result.structuredContent, undefined, "the inspector must answer with text only");
        assert.equal(resultText(result), "No background shells.");
    });
});
