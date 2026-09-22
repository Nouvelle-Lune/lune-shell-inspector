/**
 * Registration contract of pi-shell-view.
 *
 * The extension replaces pi's built-in `bash` tool by registering another definition under the same
 * name. These tests assert what pi receives at load time: exactly one tool, the built-in metadata
 * (description, prompt snippet/guidelines, constrained sampling) plus the wrapper's own optional
 * `mode` parameter, and no renderers of its own (pi merges the built-in bash renderers by tool
 * name, see `withBuiltInRenderers`). Execution behaviour is covered by
 * `test/integration/bash-delegation.test.ts` (foreground) and
 * `test/integration/background-bash.test.ts` (background mode).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import {
    createBuiltInBash,
    createTempWorkDir,
    registerExtension,
    removeTempWorkDir,
    type BashToolDefinition,
} from "../harness.ts";

describe("pi-shell-view registration", () => {
    let workDir: string;
    let tool: BashToolDefinition;

    before(() => {
        workDir = createTempWorkDir("registration");
        const host = registerExtension(workDir);
        const registeredTool = host.registeredTools.find((entry) => entry.name === "bash");
        assert.ok(registeredTool, "expected the extension to register a bash tool");
        tool = registeredTool;
    });

    after(() => {
        removeTempWorkDir(workDir);
    });

    it("registers exactly one tool named bash that mirrors the built-in definition", () => {
        // Contract: loading the extension registers a single tool named "bash" whose label,
        // description and prompt metadata come from the built-in createBashTool(cwd), so the model
        // sees the same tool contract and this wrapper cannot drift from it.
        const registered = registerExtension(workDir).registeredTools;
        assert.equal(registered.length, 1, "the extension must register exactly one tool");

        const registeredTool = registered.at(0);
        assert.ok(registeredTool, "expected one registered tool");
        const builtIn = createBuiltInBash(workDir);

        assert.equal(registeredTool.name, "bash", "the tool must be named bash so it replaces the built-in one");
        assert.equal(registeredTool.label, "bash");
        assert.equal(registeredTool.description, builtIn.description, "description must come from the built-in tool");
        assert.equal(registeredTool.promptSnippet, builtIn.promptSnippet, "prompt snippet must come from the built-in tool");
        assert.deepEqual(
            registeredTool.promptGuidelines,
            builtIn.promptGuidelines,
            "prompt guidelines must come from the built-in tool",
        );
        assert.deepEqual(
            registeredTool.constrainedSampling,
            builtIn.constrainedSampling,
            "constrained sampling must come from the built-in tool",
        );
    });

    it("ships no renderers so pi keeps drawing the row with its built-in bash renderers", () => {
        // Contract: the definition carries no renderCall/renderResult of its own, so pi's
        // withBuiltInRenderers() merge applies and the row keeps the standard "$ <command>" look.
        assert.equal(tool.renderCall, undefined, "a custom renderCall would replace pi's built-in bash call renderer");
        assert.equal(tool.renderResult, undefined, "a custom renderResult would replace pi's built-in bash result renderer");
    });

    it("extends the built-in parameter schema with an optional foreground/background mode", () => {
        // Contract: the wrapper reuses the built-in schema and adds exactly one parameter - `mode`,
        // optional, limited to "foreground" and "background". Omitting it is what the extension
        // treats as foreground, so the schema must not require it.
        const schema = tool.parameters as TSchema;

        assert.equal(Value.Check(schema, { command: "echo hello" }), true, "{command} must be accepted");
        assert.equal(Value.Check(schema, { command: "sleep 1", timeout: 30 }), true, "{command, timeout} must be accepted");
        assert.equal(
            Value.Check(schema, { command: "sleep 1", mode: "foreground" }),
            true,
            "the explicit foreground mode must be accepted",
        );
        assert.equal(
            Value.Check(schema, { command: "sleep 1", mode: "background" }),
            true,
            "the background mode must be accepted",
        );
        assert.equal(Value.Check(schema, {}), false, "an argument object without command must be rejected");
        assert.equal(Value.Check(schema, { timeout: 5 }), false, "a timeout without command must be rejected");
        assert.equal(
            Value.Check(schema, { command: "sleep 1", mode: "later" }),
            false,
            "an unknown mode must be rejected",
        );
        assert.equal(
            Value.Check(schema, { command: "sleep 1", timeout: "5" }),
            false,
            "the built-in timeout type must not be loosened",
        );
    });
});
