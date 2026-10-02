import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shellManager } from "./shell-manager.ts";

interface BackgroundShellNotification {
    jobId: string;
    jobCommand: string;
    jobStatus: string;
    jobExitCode: number | undefined;
    jobError: string | undefined;
    jobOutput: string;
}

class MessageSendBuffer<T> {
    private buffer: Array<{ item: T; retryCount: number }> = [];
    private delayTimer: ReturnType<typeof setTimeout> | null = null;
    private maxDelayTimer: ReturnType<typeof setTimeout> | null = null;

    private flushing = false;
    private disposed = false;

    private readonly MAX_BUFFER_SIZE = 10;
    private readonly MAX_DELAY_MS = 1000;

    private readonly MAX_RETRIES = 2;
    private readonly delayMs: number;
    private readonly onFlush: (batch: T[]) => void | Promise<void>;
    private readonly onFailure: (error: unknown, retrying: T[], dropped: T[]) => void;

    constructor(
        delayMs: number,
        onFlush: (batch: T[]) => void | Promise<void>,
        onFailure: (error: unknown, retrying: T[], dropped: T[]) => void,
    ) {
        this.delayMs = delayMs;
        this.onFlush = onFlush;
        this.onFailure = onFailure;
    }

    push(item: T): void {
        if (this.disposed) {
            return;
        }

        const wasEmpty = this.buffer.length === 0;

        this.buffer.push({ item, retryCount: 0 });

        if (wasEmpty) {
            this.scheduleMaxDelayFlush();
        }

        if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
            void this.flush();
            return;
        }
        this.scheduleDelayFlush();
    }

    private scheduleMaxDelayFlush(): void {
        if (this.maxDelayTimer !== null) {
            return;
        }

        this.maxDelayTimer = setTimeout(() => {
            this.maxDelayTimer = null;
            void this.flush();
        }, this.MAX_DELAY_MS);
    }

    private scheduleDelayFlush(): void {
        if (this.delayTimer !== null) {
            clearTimeout(this.delayTimer);
        }

        this.delayTimer = setTimeout(() => {
            this.delayTimer = null;

            void this.flush();
        }, this.delayMs);
    }

    private clearTimers(): void {
        if (this.delayTimer !== null) {
            clearTimeout(this.delayTimer);

            this.delayTimer = null;
        }

        if (this.maxDelayTimer !== null) {
            clearTimeout(this.maxDelayTimer);

            this.maxDelayTimer = null;
        }
    }

    async flush(): Promise<void> {
        if (this.flushing || this.buffer.length === 0) {
            return;
        }

        this.clearTimers();

        this.flushing = true;
        const batch = this.buffer.splice(0);

        try {
            await this.onFlush(batch.map(({ item }) => item));
        } catch (error) {
            const retrying = batch.filter(({ retryCount }) =>
                !this.disposed && retryCount < this.MAX_RETRIES,
            );
            const dropped = batch.filter(({ retryCount }) =>
                this.disposed || retryCount >= this.MAX_RETRIES,
            );
            for (const entry of retrying) {
                entry.retryCount += 1;
            }
            // Keep older failures ahead of arrivals during this flush, without immediate retries.
            this.buffer = retrying.concat(this.buffer);
            try {
                this.onFailure(error, retrying.map(({ item }) => item), dropped.map(({ item }) => item));
            } catch {
                // A broken diagnostic sink must not turn a contained delivery error into a rejection.
            }
        } finally {
            this.flushing = false;

            if (!this.disposed && this.buffer.length > 0) {
                this.scheduleDelayFlush();
                this.scheduleMaxDelayFlush();
            }
        }
    }

    dispose(): void {
        this.disposed = true;
        this.clearTimers();
        this.buffer = [];
    }
}

export function registerBackgroundShellNotifications(
    pi: ExtensionAPI,
    ctx?: ExtensionContext,
): () => void {
    // Resolve the UI before the runtime can invalidate context getters during reload.
    const ui = ctx?.hasUI ? ctx.ui : undefined;
    const reportFailure = (
        error: unknown,
        retrying: BackgroundShellNotification[],
        dropped: BackgroundShellNotification[],
    ): void => {
        const reason = error instanceof Error ? error.message : String(error);
        const messages: string[] = [];
        if (retrying.length > 0) {
            messages.push(`Failed to send background shell notification(s) [${retrying.map((item) => item.jobId).join(", ")}]: ${reason}. Requeued; at most 2 retries per notification.`);
        }
        if (dropped.length > 0) {
            messages.push(`Permanently failed background shell notification(s) [${dropped.map((item) => item.jobId).join(", ")}]: ${reason}. Dropped; retry limit reached or buffer disposed.`);
        }
        for (const message of messages) {
            if (ui) {
                try {
                    ui.notify(message, "error");
                    continue;
                } catch {
                    // Reload can also invalidate the UI sink; headless runs have no sink at all.
                }
            }
            console.error(message);
        }
    };
    const messageBuffer = new MessageSendBuffer<BackgroundShellNotification>(300, (batch) => {
        return pi.sendMessage(
            {
                customType: "background-shell-notification",

                content: batch
                    .map((item) =>
                        [
                            `Background shell ${item.jobId} ${item.jobStatus}.`,
                            `Command: ${item.jobCommand}`,
                            item.jobExitCode === undefined
                                ? undefined
                                : `Exit code: ${item.jobExitCode}`,
                            item.jobError ? `Error: ${item.jobError}` : undefined,
                            "",
                            "Output:",
                            item.jobOutput,
                        ]
                            .filter((line): line is string => line !== undefined)
                            .join("\n"),
                    )
                    .join("\n\n---\n\n"),

                display: false ,

                details: {
                    jobs: batch.map((item) => ({
                        shellJobId: item.jobId,
                        status: item.jobStatus,
                        exitCode: item.jobExitCode,
                    })),
                },
            },
            {
                triggerTurn: true,
                deliverAs: "steer",
            },
        );
    }, reportFailure);

    const unsubscribe = shellManager.subscribe((event) => {
        if (
            event.type !== "job-completed" &&
            event.type !== "job-failed" &&
            event.type !== "job-killed"
        ) {
            return;
        }

        const job = shellManager.getJob(event.id);

        if (!job) {
            return;
        }

        const output = shellManager.getJobOutput(event.id);

        messageBuffer.push({
            jobId: job.id,
            jobCommand: job.command,
            jobStatus: job.status,
            jobExitCode: job.exitCode,
            jobError: job.error,
            jobOutput: output,
        });
    });

    return () => {
        unsubscribe();
        messageBuffer.dispose();
    };
}
