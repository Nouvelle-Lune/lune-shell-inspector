/**
 * The `bash` tool pi-shell-view registers in place of pi's built-in one.
 *
 * pi uses the definition registered under an existing name instead of the built-in one.
 * `mode: "foreground"` (the default) delegates the call to the built-in bash tool unchanged;
 * `mode: "background"` starts a managed shell job whose execution continues after the call returned
 * and is reported by the shell dock. pi's `withBuiltInRenderers` only fills renderers a definition
 * does not supply, so the wrapper ships its own: a foreground row delegates to the built-in bash
 * renderers (keeping the standard `$ <command>` look and never drifting from it), while a background
 * row renders empty because the detached job is reported by the shell dock and the `/shell`
 * inspector, not by a transcript row that could never stream the output.
 */
import {
    createBashTool,
    createBashToolDefinition,
    defineTool,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import Type from "typebox";

import { startBackgroundShell } from "./background-bash.ts";

/**
 * Build the wrapper definition for one extension load.
 *
 * A factory rather than a module-level constant: the built-in definition binds its working
 * directory at construction time, so the definition must be built where the load-time cwd is known
 * and can later take extension-level configuration.
 */
export function BashTool() {
    // Reuse the built-in definition and extend its schema with `mode`, so the rest of the tool
    // contract the model sees cannot drift from the built-in one.
    const baseBash = createBashToolDefinition(process.cwd());

    const description =
        baseBash.description +
        ` Long-running commands should emit meaningful periodic progress to stdout or stderr ` +
        `and normally run in background mode so their output remains observable for user.`;
    const parameters = Type.Object({
        ...baseBash.parameters.properties,
        mode: Type.Optional(
            Type.Union([
                Type.Literal("foreground"),
                Type.Literal("background"),
            ], {
                description:
                    `"foreground" waits for completion; use it when the result is needed before continuing. ` +
                    `"background" keeps long-running, progress-producing commands observable while the agent continues.`,
                default: "foreground",
            }),
        )
    });

    return defineTool({
        ...baseBash,
        description,
        parameters,

        renderCall(args, theme, context) {
            if ((args.mode ?? "foreground") === "background") {
                return new Container();
            }
            return baseBash.renderCall!(args, theme, context);
        },

        renderResult(result, options, theme, context) {
            if ((context.args.mode ?? "foreground") === "background") {
                return new Container();
            }
            return baseBash.renderResult!(result as Parameters<NonNullable<typeof baseBash.renderResult>>[0], options, theme, context);
        },

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            // Foreground is the default: delegate the call unchanged. The dock only tracks
            // background shells, so a foreground call must not touch the manager.
            if ((params.mode ?? "foreground") === "foreground") {
                // The built-in tool binds its cwd at construction time, and ctx.cwd can differ from
                // process.cwd(); rebuild it per call.
                const builtInBash = createBashTool(ctx.cwd);
                return builtInBash.execute(
                    toolCallId,
                    params,
                    signal,
                    onUpdate,
                );
            }

            // Background returns at once; the detached execution settles the job later.
            return startBackgroundShell(
                toolCallId,
                params.command,
                params.timeout,
                ctx
            );

        },
    });
}

