/**
 * Registration contract of pi-shell-view.
 *
 * The extension replaces pi's built-in `bash` tool by registering another definition under the same
 * name. These tests assert what pi receives at load time: exactly one tool, the built-in description
 * and parameter schema, and no renderers of its own (pi merges the built-in bash renderers by tool
 * name, see `withBuiltInRenderers`). Execution behaviour is covered by
 * `test/integration/bash-delegation.test.ts` and `test/integration/fixtures.test.ts`.
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
        // description and parameter schema come from the built-in createBashTool(cwd).
        const registered = registerExtension(workDir).registeredTools;
        assert.equal(registered.length, 1, "the extension must register exactly one tool");

        const registeredTool = registered.at(0);
        assert.ok(registeredTool, "expected one registered tool");
        const builtIn = createBuiltInBash(workDir);

        assert.equal(registeredTool.name, "bash", "the tool must be named bash so it replaces the built-in one");
        assert.equal(registeredTool.label, "bash");
        assert.equal(registeredTool.description, builtIn.description, "description must come from the built-in tool");
        assert.deepEqual(registeredTool.parameters, builtIn.parameters, "parameter schema must come from the built-in tool");
    });

    it("ships no renderers so pi keeps drawing the row with its built-in bash renderers", () => {
        // Contract: the definition carries no renderCall/renderResult of its own, so pi's
        // withBuiltInRenderers() merge applies and the row keeps the standard "$ <command>" look.
        assert.equal(tool.renderCall, undefined, "a custom renderCall would replace pi's built-in bash call renderer");
        assert.equal(tool.renderResult, undefined, "a custom renderResult would replace pi's built-in bash result renderer");
    });

    it("exports the built-in parameter schema: command required, timeout optional", () => {
        // Contract: the registered schema accepts {command} and {command, timeout} and rejects an
        // argument object without a command string.
        const schema = tool.parameters as TSchema;

        assert.equal(Value.Check(schema, { command: "echo hello" }), true, "{command} must be accepted");
        assert.equal(Value.Check(schema, { command: "sleep 1", timeout: 30 }), true, "{command, timeout} must be accepted");
        assert.equal(Value.Check(schema, {}), false, "an argument object without command must be rejected");
        assert.equal(Value.Check(schema, { timeout: 5 }), false, "a timeout without command must be rejected");
    });
});
