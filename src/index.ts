/**
 * pi-shell-view: a wrapper around pi's built-in `bash` tool.
 *
 * The extension re-registers the tool under the same name, so pi uses this definition instead of the
 * built-in one. It only observes: the command is announced in the session UI, then the call is
 * delegated to the built-in bash tool unchanged. No renderers are supplied on purpose - pi merges the
 * built-in renderers by tool name (see `withBuiltInRenderers`), so the row keeps its standard
 * `$ <command>` look and this definition cannot drift from it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";

import { clearShellDock, renderShellDock } from "./shell/shell-dock.ts";

import { shellManager } from "./shell/shell-manager.ts"

import { getAgentToolTextResult } from "./utils/get-agent-tool-result.ts";

export default function (pi: ExtensionAPI): void {

    let _ctx;
    pi.on("session_start", async (event, ctx) => {
        _ctx = ctx;
    })
    function debuglog(message: string, level: string = "info") {
        _ctx!.ui.notify(message, level);
    }

    let unsubscribeShellManager:
        | (() => void)
        | undefined;

    pi.on("session_start", (_event, ctx) => {
        // Module state may survive extension reloads, so a new session starts
        // with an explicitly empty shell view.
        shellManager.clearAllJobs();

        // Drop the previous session's listener first: it closes over a stale
        // ctx, and duplicate subscriptions would render twice per job update.
        unsubscribeShellManager?.();

        unsubscribeShellManager =
            shellManager.subscribe(() => {
                renderShellDock(ctx);
            });

        renderShellDock(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
        // Unsubscribe before clearing: clearAllJobs() emits, and a live
        // listener would re-render the dock after it was removed.
        unsubscribeShellManager?.();
        unsubscribeShellManager = undefined;
        clearShellDock(ctx);
        shellManager.clearAllJobs();
    });

    // Reuse the built-in prompt and schema so this wrapper cannot drift from
    // the tool contract the model sees.
    const {
        description,
        parameters,
    } = createBashTool(process.cwd());

    pi.registerTool({
        name: "bash",
        label: "bash",
        description,
        parameters,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            // The built-in tool binds its cwd at construction time, and ctx.cwd
            // can differ from process.cwd(); rebuild it per call.
            const builtInBash = createBashTool(ctx.cwd);

            // toolCallId is the job key: later updates and completion are
            // matched against it.
            shellManager.startJob({
                id: toolCallId,
                command: params.command,
                cwd: ctx.cwd,
            });

            debuglog(`Executing command: ${params.command}`, "warning");

            try {
                const result = await builtInBash.execute(
                    toolCallId,
                    params,
                    signal,
                    (update) => {
                        const output = getAgentToolTextResult(update);

                        shellManager.updateOutput(toolCallId, output);

                        onUpdate?.(update);
                    },
                );

                const output = getAgentToolTextResult(result);

                shellManager.completeJob(
                    toolCallId,
                    output,
                );

                return result;

            } catch (error) {
                // Only Error values carry a message worth mirroring into the dock.
                if (!(error instanceof Error)) {
                    throw error;
                }

                // Aborted means the caller cancelled, which the dock shows
                // differently from a real failure.
                if (signal?.aborted) {
                    shellManager.stopJob(
                        toolCallId,
                        error.message,
                    );
                } else {
                    shellManager.failJob(
                        toolCallId,
                        error.message,
                    );
                }

                // Rethrow so pi still reports the failure to the model.
                throw error;
            }
        },
    });
}
