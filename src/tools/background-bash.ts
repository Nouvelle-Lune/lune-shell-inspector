import {
    createLocalBashOperations,
    type AgentToolResult,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { shellManager } from "../shell/shell-manager.ts";

// pi's own local execution backend, so a background shell behaves like a built-in bash call
// (shell config, process-tree kill on abort/timeout) without pi's output sanitizing.
const backgroundOps = createLocalBashOperations();

/**
 * Start a managed background shell and return before the command finishes.
 *
 * The tool call answers immediately; the detached execution below appends output to the job and
 * settles it once the process ends - completed only on exit code 0, failed with the code and reason
 * on any other exit - or the execution itself fails.
 */
export function startBackgroundShell(
    toolCallId: string,
    command: string,
    timeout: number | undefined,
    ctx: ExtensionContext,
): AgentToolResult {
    // The job owns this controller so a kill can abort the running process tree.
    const controller = new AbortController();

    shellManager.startJob({
        id: toolCallId,
        command,
        cwd: ctx.cwd,
        controller: controller,
    });

    void backgroundOps
        .exec(command, ctx.cwd, {
            signal: controller.signal,
            timeout,

            onData(data) {
                // TODO: the job output grows without bound - no byte cap and no truncation - so a
                // chatty long-running command can exhaust memory. Add a retention limit here (or in
                // ShellManager.appendOutput) before this path is used for real workloads.
                shellManager.appendOutput(
                    toolCallId,
                    data.toString("utf8"),
                );
            },
        })
        .then(({ exitCode }) => {
            if (exitCode === 0) {
                shellManager.settleJob(toolCallId, {
                    type: "completed",
                    exitCode: exitCode ?? undefined,
                });
                return;
            }
            const errorMessage = `Background shell exited with code ${exitCode ?? "unknown"}`;
            shellManager.settleJob(toolCallId, {
                type: "failed",
                exitCode: exitCode ?? undefined,
                error: errorMessage,
            });
            return;
        })
        .catch((error: Error) => {
            // An aborted signal means the job was killed (session teardown or an explicit kill);
            // any other error (timeout, missing cwd, spawn failure) is an execution failure.
            // settleJob is idempotent, so a job that was already settled or cleared is ignored.
            if (controller.signal.aborted) {
                shellManager.settleJob(toolCallId, {
                    type: "killed",
                    error: error.message,
                });
                return;
            }

            shellManager.settleJob(toolCallId, {
                type: "failed",
                error: error.message,
            });
        });

    return {
        content: [
            {
                type: "text" as const,
                text:
                    `Background shell started ${toolCallId}: ${command}`,
            },
        ],
        details: {
            shellJobId: toolCallId,
            background: true,
        },
    };
}
