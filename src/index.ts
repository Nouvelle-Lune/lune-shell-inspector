import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { shellDock } from "./shell/shell-dock.ts";

import { shellManager } from "./shell/shell-manager.ts"

import { openShellInspector } from "./shell/shell-inspector.ts";

import { BashTool } from "./tools/bash-tool.ts";

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

    // Register tools
    pi.registerTool(BashTool());

    // Register commands
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
