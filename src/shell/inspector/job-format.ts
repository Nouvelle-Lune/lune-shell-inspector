import type { Theme } from "@earendil-works/pi-coding-agent";

import { collapseShellCommand, fitShellCommand } from "../shell-command.ts";
import type { ShellJob, ShellJobStatus } from "../shell-manager.ts";

export type ThemeColor = Parameters<Theme["fg"]>[0];

const MAX_CACHED_COMMANDS = 64;

/**
 * Single-row previews of job commands.
 *
 * Collapsing and measuring scales with the command length, and a heredoc script is tens of
 * kilobytes; the same few commands are previewed again on every frame, so they are done once.
 */
export class CommandPreviews {
    private readonly byCommand = new Map<string, { collapsed: string; fitted: Map<number, string> }>();

    fit(command: string, maxWidth: number): string {
        let entry = this.byCommand.get(command);

        if (!entry) {
            if (this.byCommand.size >= MAX_CACHED_COMMANDS) {
                this.byCommand.clear();
            }

            entry = { collapsed: collapseShellCommand(command), fitted: new Map() };
            this.byCommand.set(command, entry);
        }

        let preview = entry.fitted.get(maxWidth);

        if (preview === undefined) {
            preview = fitShellCommand(entry.collapsed, maxWidth);
            entry.fitted.set(maxWidth, preview);
        }

        return preview;
    }

    clear(): void {
        this.byCommand.clear();
    }
}

export function statusColor(status: ShellJobStatus): ThemeColor {
    switch (status) {
        case "running":
            return "accent";
        case "completed":
            return "success";
        case "failed":
            return "error";
        case "killed":
            return "muted";
    }
}

export function jobMeta(job: Readonly<ShellJob>): string {
    const parts = [job.cwd, formatDuration((job.finishedAt ?? Date.now()) - job.startedAt)];

    if (job.exitCode !== undefined) {
        parts.push(`exit ${job.exitCode}`);
    }

    return parts.join(" · ");
}

function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${ms}ms`;
    }

    const seconds = ms / 1000;

    if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
    }

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) {
        return `${minutes}m${Math.floor(seconds % 60)}s`;
    }

    return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
