import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { shellDock } from "./shell/shell-dock.ts";

import { shellManager } from "./shell/shell-manager.ts"

import { openShellInspector } from "./shell/shell-inspector.ts";

import { BashTool, BackgroundShellTool, KillBackgroundShellTool } from "./tools/bash-tool.ts";
import {
    BACKGROUND_SHELL_NOTIFICATION_TYPE,
    registerBackgroundShellNotifications,
    type BackgroundShellNotificationDetails,
} from "./shell/shell-notification.ts";
import { renderBackgroundShellNotificationBox } from "./shell/shell-notification-box.ts";

export default function (pi: ExtensionAPI): void {

    // Registered once per load: the transcript looks the renderer up by custom type when it draws
    // the message, so a session-scoped registration would only re-register the same function.
    pi.registerMessageRenderer<BackgroundShellNotificationDetails>(
        BACKGROUND_SHELL_NOTIFICATION_TYPE,
        renderBackgroundShellNotificationBox,
    );

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
        unsubscribeBackgroundShellNotifications = registerBackgroundShellNotifications(pi, ctx);

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
            unsubscribeBackgroundShellNotifications = registerBackgroundShellNotifications(pi, ctx);
        }

    });

    pi.on("session_tree", (_event, ctx) => {
        shellManager.clearAllJobs();
        shellManager.restoreShellManager(ctx);
        shellDock.render();
    });

    // Register tools
    // The background tools only read the shared shell manager, so they ship with the wrapper that
    // starts the jobs; a separate extension could not see them.
    pi.registerTool(BashTool());
    pi.registerTool(BackgroundShellTool());
    pi.registerTool(KillBackgroundShellTool());

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
