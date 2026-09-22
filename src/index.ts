/**
 * pi-shell-view: a wrapper around pi's built-in `bash` tool.
 *
 * The extension re-registers the tool under the same name, so pi uses this definition instead of the
 * built-in one. `mode: "foreground"` (the default) delegates the call to the built-in bash tool
 * unchanged; `mode: "background"` starts a managed shell job whose execution continues after the
 * call returned and is reported by the shell dock. pi's `withBuiltInRenderers` only fills renderers
 * a definition does not supply, so the wrapper ships its own: a foreground row delegates to the
 * built-in bash renderers (keeping the standard `$ <command>` look and never drifting from it),
 * while a background row renders empty because the detached job is reported by the shell dock and
 * the `/shell` inspector, not by a transcript row that could never stream the output.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import Type from "typebox";

import { shellDock } from "./shell/shell-dock.ts";

import { shellManager } from "./shell/shell-manager.ts"

import { openShellInspector } from "./shell/shell-inspector.ts";

import { startBackgroundShell } from "./tools/background-bash.ts";

export default function (pi: ExtensionAPI): void {

    let unsubscribeShellManager:
        | (() => void)
        | undefined;

    pi.on("session_start", (_event, ctx) => {
        // Module state may survive extension reloads, so a new session starts
        // with an explicitly empty shell view.
        shellManager.clearAllJobs();

        shellDock.setCtx(ctx)

        // Drop the previous session's listener first: it closes over a stale
        // ctx, and duplicate subscriptions would render twice per job update.
        unsubscribeShellManager?.();

        unsubscribeShellManager =
            shellManager.subscribe(() => {
                shellDock.render();
            });

        shellDock.render();
    });

    pi.on("session_shutdown", (_event, ctx) => {
        // Unsubscribe before clearing: clearAllJobs() emits, and a live
        // listener would re-render the dock after it was removed.
        unsubscribeShellManager?.();
        unsubscribeShellManager = undefined;
        shellDock.clear();
        shellManager.clearAllJobs();
    });

    // Reuse the built-in definition and extend its schema with `mode`, so the rest of the tool
    // contract the model sees cannot drift from the built-in one.
    const baseBash = createBashToolDefinition(process.cwd());

    const parameters = Type.Object({
        ...baseBash.parameters.properties,
        mode: Type.Optional(
            Type.Union([
                Type.Literal("foreground"),
                Type.Literal("background"),
            ], {
                description:
                    'Execution mode. Use "foreground" when the command result, output, or exit status is needed before continuing. ' +
                    'Use "background" only for commands that may continue independently; the tool returns immediately and the shell is managed as a background job. ' +
                    'Omit this field to use "foreground".',
                default: "foreground",
            }),
        )
    });

    pi.registerTool({
        ...baseBash,
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

    pi.registerCommand("shell", {
        description: "Open the shell inspector",

        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                return;
            }

            await openShellInspector(ctx);
        },
    });
}
