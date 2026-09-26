import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shellManager } from "./shell-manager.ts";

export function registerBackgroundShellNotifications(
    pi: ExtensionAPI,
): () => void {
    return shellManager.subscribe((event) => {
        if (event.type !== "job-completed" && event.type !== "job-failed" && event.type !== "job-killed") {
            return;
        }
        const job = shellManager.getJob(event.id);
        if (!job) {
            return;
        }
        const output = shellManager.getJobOutput(event.id);

        pi.sendMessage(
            {
                customType: "background-shell-notification",
                content: [
                    `Background shell ${job.id} ${job.status}.`,
                    `Command: ${job.command}`,
                    job.exitCode === undefined
                        ? undefined
                        : `Exit code: ${job.exitCode}`,
                    job.error ? `Error: ${job.error}` : undefined,
                    "",
                    "Output:",
                    output,
                ]
                    .filter((line): line is string => line !== undefined)
                    .join("\n"),
                display: false,
                details: {
                    shellJobId: job.id,
                    status: job.status,
                    exitCode: job.exitCode,
                },
            },
            {
                triggerTurn: true,
                deliverAs: "steer",
            },
        );
    });
}


