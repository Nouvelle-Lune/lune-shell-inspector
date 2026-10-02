import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shellManager } from "./shell-manager.ts";

/** Custom message type of a settled-shell batch; the transcript box is registered for it. */
export const BACKGROUND_SHELL_NOTIFICATION_TYPE = "background-shell-notification";

/** Separator between the per-job sections of one batched notification. */
const SECTION_SEPARATOR = "\n\n---\n\n";

/** One settled job as the batched notification describes it. */
export interface BackgroundShellNotification {
    jobId: string;
    jobCommand: string;
    jobStatus: string;
    jobExitCode: number | undefined;
    jobError: string | undefined;
    jobOutput: string;
    /** Wall-clock runtime, absent while the manager has no finish timestamp to subtract from. */
    jobDurationMs: number | undefined;
}

/** One job as the transcript box renders it. */
export interface BackgroundShellNotificationJobDetails {
    shellJobId: string;
    status: string;
    exitCode: number | undefined;
    command: string;
    error: string | undefined;
    durationMs: number | undefined;
    /**
     * Where this job's output sits inside the message content.
     *
     * The box reads the text from there instead of details holding a second copy: one job can retain
     * pi's whole 50KB tail, and details are persisted next to the content they would duplicate.
     */
    output: { start: number; end: number };
}

export interface BackgroundShellNotificationDetails {
    jobs: BackgroundShellNotificationJobDetails[];
}

/**
 * Build the model-facing text and the box-facing details of one batch.
 *
 * Both halves come from here because they share the output offsets: the text is the model's copy of
 * the output and the only one stored, so the renderer has to be told where to read it.
 */
export function buildBackgroundShellNotification(batch: readonly BackgroundShellNotification[]): {
    content: string;
    details: BackgroundShellNotificationDetails;
} {
    const sections: string[] = [];
    const jobs: BackgroundShellNotificationJobDetails[] = [];
    let offset = 0;

    for (const item of batch) {
        const section = [
            `Background shell ${item.jobId} ${item.jobStatus}.`,
            `Command: ${item.jobCommand}`,
            item.jobExitCode === undefined ? undefined : `Exit code: ${item.jobExitCode}`,
            item.jobError ? `Error: ${item.jobError}` : undefined,
            "",
            "Output:",
            item.jobOutput,
        ]
            .filter((line): line is string => line !== undefined)
            .join("\n");

        sections.push(section);
        jobs.push({
            shellJobId: item.jobId,
            status: item.jobStatus,
            exitCode: item.jobExitCode,
            command: item.jobCommand,
            error: item.jobError,
            durationMs: item.jobDurationMs,
            // The output is the section's tail, so its slice starts one output length back from the end.
            output: { start: offset + section.length - item.jobOutput.length, end: offset + section.length },
        });
        offset += section.length + SECTION_SEPARATOR.length;
    }

    return { content: sections.join(SECTION_SEPARATOR), details: { jobs } };
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
        const { content, details } = buildBackgroundShellNotification(batch);

        return pi.sendMessage(
            {
                customType: BACKGROUND_SHELL_NOTIFICATION_TYPE,

                content,

                // The box is the only way a settled shell reaches the transcript; the model reads the
                // same message either way, because display never affects what is sent to it.
                display: true,

                details,
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
            jobDurationMs: job.finishedAt === undefined ? undefined : job.finishedAt - job.startedAt,
        });
    });

    return () => {
        unsubscribe();
        messageBuffer.dispose();
    };
}
