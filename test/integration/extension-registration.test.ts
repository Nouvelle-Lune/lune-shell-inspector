/**
 * Registration contract of lune-shell-inspector.
 *
 * The extension replaces pi's built-in `bash` tool by registering another definition under the same
 * name, and registers `background_shell` for reading the jobs that wrapper starts. These tests
 * assert what pi receives at load time: the two tool definitions, the built-in metadata
 * (description base, constrained sampling) plus the wrapper's own optional `mode` parameter and
 * prompt metadata, `background_shell`'s jobs schema, and the renderer contract - pi's
 * `withBuiltInRenderers` only fills renderers a definition does not supply, so the wrapper supplies
 * its own: foreground rows delegate to the built-in bash renderers, background rows render empty.
 * Execution behaviour is covered by `test/integration/bash-delegation.test.ts` (foreground),
 * `test/integration/background-bash.test.ts` (background mode) and
 * `test/integration/background-shell-tool.test.ts` (inspection).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import {
    createBuiltInBash,
    createBuiltInBashDefinition,
    createTempWorkDir,
    loadRegisteredTool,
    registerExtension,
    removeTempWorkDir,
    type BashToolDefinition,
} from "../harness.ts";

/** Width the renderer rows are measured at; wide enough that the built-in `$ <command>` row never wraps. */
const RENDER_WIDTH = 120;

/**
 * Theme argument handed to the renderers.
 *
 * The built-in shell renderers colour through pi's module-level theme (initialized by `initTheme`)
 * and ignore this argument, so a stand-in is enough to compare the wrapper's delegation with the
 * built-in renderers without re-implementing styling.
 */
const theme = {} as Theme;

/** Renderer context type pi passes to a definition's renderers; the package does not export it. */
type RenderContext = Parameters<NonNullable<BashToolDefinition["renderCall"]>>[2];

/** Renderer context of one tool row, with execution not started so the built-in renderers stay timer-free. */
function createRenderContext(args: Record<string, unknown>, workDir: string): RenderContext {
    return {
        args,
        toolCallId: "call-render",
        invalidate: () => { },
        lastComponent: undefined,
        state: { startedAt: undefined, endedAt: undefined, interval: undefined },
        cwd: workDir,
        executionStarted: false,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: false,
        isError: false,
    };
}

/** Join rendered lines and drop SGR sequences, so content assertions survive any palette. */
function plainText(lines: readonly string[]): string {
    return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("lune-shell-inspector registration", () => {
    let workDir: string;
    let tool: BashToolDefinition;

    before(() => {
        workDir = createTempWorkDir("registration");
        // The built-in shell renderers resolve their colours from pi's module-level theme.
        initTheme();
        const host = registerExtension(workDir);
        const registeredTool = host.registeredTools.find((entry) => entry.name === "bash");
        assert.ok(registeredTool, "expected the extension to register a bash tool");
        tool = registeredTool;
    });

    after(() => {
        removeTempWorkDir(workDir);
    });

    it("registers the bash wrapper plus the background_shell inspector", () => {
        // Contract: the wrapper replaces the built-in tool under the same name, so pi uses it
        // instead of the built-in one, and `background_shell` reads the jobs that wrapper starts.
        // Both come from one extension because they share the module-level shell manager. The
        // description is the built-in one plus the wrapper's own guidance for background mode.
        const registered = registerExtension(workDir).registeredTools;
        assert.deepEqual(
            registered.map((entry) => entry.name),
            ["bash", "background_shell"],
            "the extension must register the bash wrapper and the background_shell inspector",
        );

        const registeredTool = registered.find((entry) => entry.name === "bash");
        assert.ok(registeredTool, "expected the bash wrapper");
        const builtIn = createBuiltInBash(workDir);

        assert.equal(registeredTool.label, "bash");
        assert.ok(
            (registeredTool.description ?? "").startsWith(builtIn.description ?? ""),
            "the description must extend the built-in one",
        );
        assert.match(
            registeredTool.description ?? "",
            /Background mode runs the command asynchronously and returns immediately/,
            "the wrapper must document its own background mode",
        );

        // The wrapper must advertise its own background mode: inheriting the built-in snippet and
        // guidelines would leave the `mode` parameter undocumented in the system prompt.
        assert.doesNotMatch(
            builtIn.promptSnippet ?? "",
            /background/i,
            "guard: the built-in snippet must not already cover background mode",
        );
        assert.match(
            registeredTool.promptSnippet ?? "",
            /background/i,
            "the wrapper's prompt snippet must cover background mode",
        );
        const guidelines = registeredTool.promptGuidelines ?? [];
        assert.ok(
            guidelines.some((line) => /background/i.test(line)),
            "the wrapper's prompt guidelines must cover background mode",
        );
        assert.ok(
            guidelines.some((line) => /foreground/i.test(line)),
            "the wrapper's prompt guidelines must cover foreground mode",
        );

        assert.deepEqual(
            registeredTool.constrainedSampling,
            builtIn.constrainedSampling,
            "constrained sampling must come from the built-in tool",
        );
    });

    it("registers background_shell with the jobs schema and its own prompt metadata", () => {
        // Contract: the inspector takes an optional `jobs` array - omitted or empty both mean "list
        // every shell" - whose entries carry the id to inspect and the per-job output opt-in.
        const tool = loadRegisteredTool(workDir, "background_shell");
        const schema = tool.parameters as TSchema;

        assert.equal(Value.Check(schema, {}), true, "omitting jobs must list every shell");
        assert.equal(Value.Check(schema, { jobs: [] }), true, "an empty jobs array must list every shell");
        assert.equal(Value.Check(schema, { jobs: [{ jobID: "call-1" }] }), true);
        assert.equal(
            Value.Check(schema, { jobs: [{ jobID: "call-1", includeOutput: true }] }),
            true,
            "includeOutput must be accepted as a boolean",
        );
        assert.equal(
            Value.Check(schema, { jobs: [{ jobID: "call-1", includeOutput: "yes" }] }),
            false,
            "includeOutput must stay a boolean",
        );
        assert.equal(Value.Check(schema, { jobs: [{}] }), false, "an entry without jobID must be rejected");
        assert.equal(Value.Check(schema, { jobs: "call-1" }), false, "jobs must be an array");

        assert.match(tool.description, /background shells/i);
        assert.match(tool.promptSnippet ?? "", /background shells/i, "the tool must be advertised in the system prompt");
        assert.ok(
            (tool.promptGuidelines ?? []).some((line) => /intermediate output/i.test(line)),
            "the guidelines must explain when to pull intermediate output",
        );
    });

    it("delegates foreground rows to the built-in bash renderers", () => {
        // Contract: pi's withBuiltInRenderers() only fills renderers the definition does not
        // supply, so shipping a renderer without delegating would silently replace the built-in
        // "$ <command>" row. A foreground call - mode omitted or explicit - must render exactly the
        // built-in call and result rows.
        const builtIn = createBuiltInBashDefinition(workDir);
        const result = {
            content: [{ type: "text" as const, text: "hello\n" }],
            details: undefined,
        };
        const options = { expanded: false, isPartial: false };

        const foregroundArgs: Record<string, unknown>[] = [
            { command: "echo hello" },
            { command: "echo hello", mode: "foreground" },
        ];
        for (const args of foregroundArgs) {
            const call = tool.renderCall!(args, theme, createRenderContext(args, workDir));
            const builtInCall = builtIn.renderCall!(args, theme, createRenderContext(args, workDir));
            assert.deepEqual(
                call.render(RENDER_WIDTH),
                builtInCall.render(RENDER_WIDTH),
                `mode ${JSON.stringify(args.mode)} must keep the built-in call row`,
            );
            assert.match(
                plainText(builtInCall.render(RENDER_WIDTH)),
                /\$ echo hello/,
                "guard: the built-in bash row must be the consulted reference",
            );

            const resultRow = tool.renderResult!(result, options, theme, createRenderContext(args, workDir));
            const builtInResultRow = builtIn.renderResult!(result, options, theme, createRenderContext(args, workDir));
            assert.deepEqual(
                resultRow.render(RENDER_WIDTH),
                builtInResultRow.render(RENDER_WIDTH),
                `mode ${JSON.stringify(args.mode)} must keep the built-in result row`,
            );
            assert.match(plainText(resultRow.render(RENDER_WIDTH)), /hello/);
        }
    });

    it("renders background rows empty so only the shell dock reports the job", () => {
        // Contract: a background call answers before the command even runs, so a transcript row
        // would be a dead "$ ..." placeholder that can never stream output. Both renderers must
        // return an empty component; the running job belongs to the shell dock and /shell.
        const args = { command: "sleep 3600", mode: "background" as const };
        const context = createRenderContext(args, workDir);
        assert.deepEqual(
            tool.renderCall!(args, theme, context).render(RENDER_WIDTH),
            [],
            "a background call must draw no call row",
        );
        assert.deepEqual(
            tool.renderResult!(
                {
                    content: [{ type: "text" as const, text: "Background shell started call-render: sleep 3600" }],
                    details: undefined,
                },
                { expanded: false, isPartial: false },
                theme,
                context,
            ).render(RENDER_WIDTH),
            [],
            "a background result must draw no result row",
        );

        // Guard: the built-in renderers would draw a row for the same arguments, so the empty rows
        // come from the wrapper's suppression rather than from an empty result.
        const builtIn = createBuiltInBashDefinition(workDir);
        assert.notDeepEqual(
            builtIn.renderCall!(args, theme, createRenderContext(args, workDir)).render(RENDER_WIDTH),
            [],
        );
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
