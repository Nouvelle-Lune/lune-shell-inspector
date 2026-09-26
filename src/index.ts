import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { shellDock } from "./shell/shell-dock.ts";

import { shellManager } from "./shell/shell-manager.ts"

import { openShellInspector } from "./shell/shell-inspector.ts";

import { BashTool, BackgroundShellTool } from "./tools/bash-tool.ts";
import { registerBackgroundShellNotifications } from "./shell/shell-notification.ts";

export default function (pi: ExtensionAPI): void {

    let unsubscribeShellManager:
        | (() => void)
        | undefined;

    let unsubscribeBackgroundShellNotifications:
        | (() => void)
        | undefined;

    pi.on("session_start", (_event, ctx) => {
        // Module state may survive extension reloads, so a new session starts
        // with an explicitly empty shell view.
        shellManager.clearAllJobs();
        shellDock.setCtx(ctx)

        // Restore the shell manager state from the session context.
        shellManager.restoreShellManager(ctx);

        // Drop the previous session's listener first: it closes over a stale
        // ctx, and duplicate subscriptions would render twice per job update.
        unsubscribeShellManager?.();

        unsubscribeShellManager =
            shellManager.subscribe(() => {
                shellDock.render();
            });

        unsubscribeBackgroundShellNotifications?.();

        // Register background shell notifications
        unsubscribeBackgroundShellNotifications = registerBackgroundShellNotifications(pi);

        shellDock.render();
    });

    pi.on("session_shutdown", (_event, ctx) => {
        // Unsubscribe before clearing: clearAllJobs() emits, and a live
        // listener would re-render the dock after it was removed.
        unsubscribeShellManager?.();
        unsubscribeShellManager = undefined;
        shellDock.clear();
        unsubscribeBackgroundShellNotifications?.();
        unsubscribeBackgroundShellNotifications = undefined;
        shellManager.clearAllJobs(pi);
    });

    pi.on("session_before_tree", (_event, ctx) => {
        unsubscribeBackgroundShellNotifications?.();
        unsubscribeBackgroundShellNotifications = undefined;
        try {
            shellManager.clearAllJobs(pi);
        } finally {
            unsubscribeBackgroundShellNotifications = registerBackgroundShellNotifications(pi);
        }

    });

    pi.on("session_tree", (_event, ctx) => {
        shellManager.clearAllJobs();
        shellManager.restoreShellManager(ctx);
        shellDock.render();
    });

    // Register tools
    // `background_shell` only reads the shared shell manager, so it ships with the wrapper that
    // starts the jobs; a separate extension could not see them.
    pi.registerTool(BashTool());
    pi.registerTool(BackgroundShellTool());

    // Register commands
    pi.registerCommand("shell", {
        description: "Open the shell inspector",
        handler: async (_args, ctx) => {
            if (shellManager.getAllJobsList().length === 0) {
                return;
            }
            if (ctx.mode !== "tui") {
                return;
            }
            await openShellInspector(ctx);
        },
    });
}
