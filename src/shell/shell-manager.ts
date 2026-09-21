export type ShellJobStatus =
    | "running"
    | "completed"
    | "failed"
    | "stopped";

export interface ShellJob {
    id: string;
    command: string;
    cwd: string;

    status: ShellJobStatus;

    startedAt: number;
    finishedAt?: number;
    lastActivityAt: number;

    output: string;

    exitCode?: number;
    error?: string;
}

export type ShellManagerListener = () => void;

export class ShellManager {
    private readonly jobs = new Map<string, ShellJob>();
    private readonly listeners = new Set<ShellManagerListener>();

    startJob(input: {
        id: string;
        command: string;
        cwd: string;
    }): void {
        // Ids come from tool call ids; a duplicate means a caller bug, and
        // overwriting would discard a live job's output mid-stream.
        if (this.jobs.has(input.id)) {
            throw new Error(`Shell job already exists: ${input.id}`);
        }

        const now = Date.now();

        this.jobs.set(input.id, {
            id: input.id,
            command: input.command,
            cwd: input.cwd,
            status: "running",
            startedAt: now,
            lastActivityAt: now,
            output: "",
        });

        this.emit();
    }

    completeJob(id: string, output: string): void {
        const job = this.getRunningJob(id);
        const now = Date.now();

        job.output = output;
        job.status = "completed";
        job.finishedAt = now;
        job.lastActivityAt = now;

        this.emit();
    }

    failJob(
        id: string,
        error: string,
        exitCode?: number,
    ): void {
        const job = this.getRunningJob(id);
        const now = Date.now();

        job.status = "failed";
        job.error = error;
        job.exitCode = exitCode;
        job.finishedAt = now;
        job.lastActivityAt = now;

        this.emit();
    }

    stopJob(id: string, error: string): void {
        const job = this.getRunningJob(id);
        const now = Date.now();

        job.status = "stopped";
        job.error = error;
        job.finishedAt = now;
        job.lastActivityAt = now;

        this.emit();
    }

    clearAllJobs(): void {
        this.jobs.clear();
        this.emit();
    };

    updateOutput(id: string, output: string): void {
        const job = this.requireJob(id);

        // Only running jobs stream; a late update would overwrite the
        // authoritative final output.
        if (job.status !== "running") {
            throw new Error(
                `Cannot update output for shell job "${id}" in status "${job.status}"`,
            );
        }

        job.output = output;
        job.lastActivityAt = Date.now();

        this.emit();
    }

    getJob(id: string): Readonly<ShellJob> | undefined {
        // Readonly is compile-time only: callers get the live internal job.
        return this.jobs.get(id);
    }

    getAllJobsList(): readonly Readonly<ShellJob>[] {
        return Array.from(this.jobs.values());
    }

    getRunningJobsList(): readonly Readonly<ShellJob>[] {
        return Array.from(this.jobs.values()).filter(
            (job) => job.status === "running",
        );
    }

    subscribe(listener: ShellManagerListener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    private requireJob(id: string): ShellJob {
        const job = this.jobs.get(id);

        if (!job) {
            throw new Error(`Unknown shell job: ${id}`);
        }

        return job;
    }

    private getRunningJob(id: string): ShellJob {
        const job = this.requireJob(id);

        if (job.status !== "running") {
            throw new Error(
                `Shell job "${id}" is not running: ${job.status}`,
            );
        }

        return job;
    }

    private emit(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}

// Shared singleton: its state outlives extension reloads, which is why the
// extension clears it explicitly on session start.
export const shellManager = new ShellManager();