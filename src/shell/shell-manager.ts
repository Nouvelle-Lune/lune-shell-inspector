import { DEFAULT_MAX_LINES, truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import xterm, { type Terminal as XtermTerminal } from "@xterm/headless";

// @xterm/headless ships CommonJS, and its UMD factory hides the exports from Node's
// named-export detection, so the class has to come off the default import.
const { Terminal } = xterm;

import {
    appendFileSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

/**
 * Geometry of the per-job VT emulator.
 *
 * Progress bars, spinners, clear-line and cursor moves only mean something on a screen, so the
 * raw stream is replayed into a headless terminal and readers get the resulting screen. The
 * geometry is fixed because the stream comes from a pipe: no program ever saw a window size.
 */
const SCREEN_COLS = 120;
const SCREEN_ROWS = 30;

const SCREEN_SCROLLBACK = DEFAULT_MAX_LINES;

export type ShellJobStatus =
    | "running"
    | "completed"
    | "failed"
    | "killed";

export interface ShellJob {
    id: string;
    command: string;
    cwd: string;

    status: ShellJobStatus;

    startedAt: number;
    finishedAt?: number;
    lastActivityAt: number;

    output: JobOutput;

    /** VT emulator that has executed `output`; read it through `getScreenLines()`. */
    terminal: XtermTerminal;

    exitCode?: number;
    error?: string;

    controller: AbortController;
}

export interface JobsStatusStat {
    runningCount: number;
    completedCount: number;
    failedCount: number;
    killedCount: number;
}

/**
 * Bounded copy of a job's output plus the totals of everything appended so far.
 *
 * `content` carries the whole text until it crosses pi's tail limits (2000 lines / 50KB); after
 * that it keeps the tail only while the complete stream is spilled to `fullOutputPath`.
 */
export interface JobOutput {
    content: string;
    truncated: boolean;

    /** Newlines appended so far: a final line without a trailing newline is not counted. */
    totalLines: number;
    totalBytes: number;

    fullOutputPath?: string;
}

export type ShellManagerEvent =
    | { type: "job-started"; id: string }
    | { type: "job-completed"; id: string }
    | { type: "job-failed"; id: string }
    | { type: "job-killed"; id: string }
    | { type: "jobs-cleared" }
    | { type: "output-updated"; id: string };

export type ShellJobOutcome =
    | {
        type: "completed";
        exitCode?: number;
    }
    | {
        type: "failed";
        error: string;
        exitCode?: number;
    }
    | {
        type: "killed";
        error?: string;
    };

export type ShellManagerListener = (event: ShellManagerEvent) => void;

export class ShellManager {
    private readonly jobs = new Map<string, ShellJob>();
    private readonly listeners = new Set<ShellManagerListener>();
    readonly jobsStatusStat: JobsStatusStat;
    constructor() {
        this.jobsStatusStat = {
            runningCount: 0,
            completedCount: 0,
            failedCount: 0,
            killedCount: 0,
        };
    }

    startJob(input: {
        id: string;
        command: string;
        cwd: string;
        controller: AbortController;
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
            output: {
                content: "",
                truncated: false,
                totalLines: 0,
                totalBytes: 0,
            },
            terminal: createScreen(),
            controller: input.controller,
        });

        this.jobsStatusStat.runningCount++;

        this.emit({
            type: "job-started",
            id: input.id
        });
    }

    /**
     * 
     * @param pi The extension API instance, used to persist the current state of all jobs and their statistics to the pi session log.
     */
    clearAllJobs(pi?: ExtensionAPI): void {
        // Session teardown must not leave processes running behind the cleared job list.
        const runningJobs = this.getRunningJobsList();
        for (const job of runningJobs) {
            this.killJob(job.id, "pi session shutdown");
        }

        // Persist the current state of all jobs and their statistics to the pi session log.
        if (pi) {
            pi.appendEntry("lune-shell-view-status", {
                jobs: this.getAllJobsList().map(job => this.getJobSnapshot(job.id)),
                stats: this.getAllJobsStatusStat()
            });
        }

        // Dropping the map alone would leave every emulator and its emitters alive.
        for (const job of this.jobs.values()) {
            job.terminal.dispose();
        }

        // clear the manager status before emitting the jobs-cleared event
        this.jobs.clear();
        this.clearManagerstatus();
        this.emit({
            type: "jobs-cleared"
        });
    };

    appendOutput(
        id: string,
        chunk: string,
    ): void {
        const job = this.getRunningJob(id);
        const next = job.output.content + chunk;
        job.output.totalBytes += Buffer.byteLength(chunk);
        job.output.totalLines += (chunk.match(/\n/g) ?? []).length;

        if (job.output.fullOutputPath !== undefined) {
            appendFileSync(job.output.fullOutputPath, chunk, "utf8");

            job.output.content = truncateTail(next).content;
        } else {
            const truncation = truncateTail(next);
            if (!truncation.truncated) {
                job.output.content = next;
            } else {
                const path = join(
                    tmpdir(),
                    `lune-shell-inspector-bash-${randomUUID()}.log`,
                );
                writeFileSync(path, next, "utf8");

                job.output.fullOutputPath = path;
                job.output.truncated = true;
                job.output.content = truncation.content;
            }
        }

        job.lastActivityAt = Date.now();

        // xterm parses queued writes on a later tick. Readers render after it: the TUI schedules
        // its frame through nextTick + setTimeout, while this write is parsed by the first timer.
        job.terminal.write(chunk);

        this.emit({
            type: "output-updated",
            id: id
        });
    }

    getJobOutput(id: string): string {
        const job = this.requireJob(id);

        if (!job.output.truncated) {
            return job.output.content;
        }

        return `[Output truncated. Full output: ${job.output.fullOutputPath ?? "N/A"}]\n${job.output.content}`;
    }

    /**
     * The job's screen as logical lines: the raw output after a terminal executed it.
     *
     * A line is only as wide as the program wrote it - continuation rows of a wrapped line are
     * joined back together - so callers can re-wrap or truncate to their own width.
     */
    getScreenLines(id: string): string[] {
        const buffer = this.requireJob(id).terminal.buffer.active;
        const lines: string[] = [];

        for (let y = 0; y < buffer.length; y++) {
            const line = buffer.getLine(y);

            if (!line) {
                continue;
            }

            const text = line.translateToString(true);

            // `isWrapped` marks the row the emulator wrapped the previous line onto.
            if (line.isWrapped) {
                lines[lines.length - 1] = (lines.at(-1) ?? "") + text;
            } else {
                lines.push(text);
            }
        }

        // The screen is padded to its full height, so its trailing blank rows are not output.
        while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") {
            lines.pop();
        }

        return lines;
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

    getCompletedJobsList(): readonly Readonly<ShellJob>[] {
        return Array.from(this.jobs.values()).filter(
            (job) => job.status === "completed",
        );
    }

    getAllJobsStatusStat(): JobsStatusStat {
        return {
            runningCount: this.jobsStatusStat.runningCount,
            completedCount: this.jobsStatusStat.completedCount,
            failedCount: this.jobsStatusStat.failedCount,
            killedCount: this.jobsStatusStat.killedCount,
        };
    }

    subscribe(listener: ShellManagerListener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    settleJob(
        id: string,
        outcome: ShellJobOutcome,
    ): boolean {
        // Settling is idempotent: the detached execution can race session teardown, and a job that
        // is unknown or no longer running must not be settled again (or counted twice).
        if (this.getJob(id)?.status !== "running") {
            return false;
        }

        if (outcome.type === "completed") {
            this.completeJob(id, outcome.exitCode);
        } else if (outcome.type === "failed") {
            this.failJob(id, outcome.error, outcome.exitCode);
        } else if (outcome.type === "killed") {
            this.killJob(id, outcome.error ?? "killed");
        }

        return true;
    }

    restoreShellManager(ctx: ExtensionContext): void {
        const shellStateEntry = [...ctx.sessionManager.getBranch()]
            .reverse()
            .find(
                entry =>
                    entry.type === "custom" &&
                    entry.customType === "lune-shell-view-status"
            );

        if (!shellStateEntry || shellStateEntry.type !== "custom") return;

        const snapshot = shellStateEntry.data as {
            jobs: Array<Omit<ShellJob, "terminal" | "controller">>;
            stats: JobsStatusStat;
        };

        for (const saved of snapshot.jobs) {
            const terminal = createScreen();
            terminal.write(saved.output.content);

            this.jobs.set(saved.id, {
                ...saved,
                output: { ...saved.output },
                terminal,
                controller: new AbortController(),
            });
        }

        Object.assign(this.jobsStatusStat, snapshot.stats);
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

    private emit(event: ShellManagerEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                // Ignore errors thrown by listeners to prevent one failing listener from affecting others.
            }
        }
    }

    private completeJob(id: string, exitCode?: number): void {
        const job = this.getRunningJob(id);
        const now = Date.now();

        job.status = "completed";
        job.exitCode = exitCode;
        job.finishedAt = now;
        job.lastActivityAt = now;

        this.jobsStatusStat.runningCount--;
        this.jobsStatusStat.completedCount++;

        this.emit({
            type: "job-completed",
            id: id
        });
    }

    private failJob(
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

        this.jobsStatusStat.runningCount--;
        this.jobsStatusStat.failedCount++;

        this.emit({
            type: "job-failed",
            id: id
        });
    }

    private killJob(id: string, error: string): void {
        const job = this.getRunningJob(id);
        const now = Date.now();

        // Aborting is what stops the process tree; a killed job has no exit code of its own.
        job.controller.abort();
        job.status = "killed";
        job.error = error;
        job.finishedAt = now;
        job.lastActivityAt = now;

        this.jobsStatusStat.runningCount--;
        this.jobsStatusStat.killedCount++;

        this.emit({
            type: "job-killed",
            id: id
        });
    }

    private clearManagerstatus() {
        this.jobsStatusStat.runningCount = 0;
        this.jobsStatusStat.completedCount = 0;
        this.jobsStatusStat.failedCount = 0;
        this.jobsStatusStat.killedCount = 0;
    }

    private getJobSnapshot(jobID: string) {
        const job = this.getJob(jobID);
        if (!job) {
            return {
                id: jobID,
            };
        }
        return {
            id: job.id,
            command: job.command,
            cwd: job.cwd,
            status: job.status,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            lastActivityAt: job.lastActivityAt,
            exitCode: job.exitCode,
            error: job.error,
            output: {
                content: job.output.content,
                truncated: job.output.truncated,
                totalLines: job.output.totalLines,
                totalBytes: job.output.totalBytes,
                fullOutputPath: job.output.fullOutputPath,
            }
        }
    }
}

function createScreen(): XtermTerminal {
    return new Terminal({
        cols: SCREEN_COLS,
        rows: SCREEN_ROWS,
        scrollback: SCREEN_SCROLLBACK,
        // The stream comes from a pipe, so unlike a PTY nothing turns a bare LF into CRLF.
        convertEol: true,
        // Reading the framebuffer is still gated behind xterm's proposed API.
        allowProposedApi: true,
    });
}

// Shared singleton: its state outlives extension reloads, which is why the
// extension clears it explicitly on session start.
export const shellManager = new ShellManager();