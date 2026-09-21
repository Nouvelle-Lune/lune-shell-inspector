
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    shellManager,
    type ShellJob,
} from "./shell-manager.ts";

// Stable id: setWidget(id, undefined) is the only way to remove the row.
const WIDGET_ID = "pi-shell-view";

// Commands can span lines (heredocs, chained commands); the dock renders one row.
function normalizeCommand(command: string): string {
    return command.replace(/\s+/g, " ").trim();
}

function truncateCommand(
    command: string,
    maxLength: number,
): string {
    const normalized = normalizeCommand(command);

    if (normalized.length <= maxLength) {
        return normalized;
    }

    // Reserve one cell for the ellipsis so the row stays within maxLength.
    return `${normalized.slice(0, maxLength - 1)}…`;
}

// Jobs keep insertion order, so reversing yields the newest running command;
// the dock shows only one.
function getLatestRunningJob(
    jobs: readonly Readonly<ShellJob>[],
): Readonly<ShellJob> | undefined {
    return [...jobs]
        .reverse()
        .find((job) => job.status === "running");
}

export function renderShellDock(
    ctx: ExtensionContext,
): void {
    // Non-interactive sessions have no widget surface.
    if (!ctx.hasUI) {
        return;
    }

    const jobs = shellManager.getAllJobsList();

    // Remove the widget rather than leaving an empty row.
    if (jobs.length === 0) {
        ctx.ui.setWidget(WIDGET_ID, undefined);
        return;
    }

    const running = jobs.filter(
        (job) => job.status === "running",
    ).length;

    const completed = jobs.filter(
        (job) => job.status === "completed",
    ).length;

    const failed = jobs.filter(
        (job) => job.status === "failed",
    ).length;

    const stopped = jobs.filter(
        (job) => job.status === "stopped",
    ).length;

    const parts = [
        `${jobs.length} shells`,
    ];

    if (running > 0) {
        parts.push(`${running} running`);
    }

    if (completed > 0) {
        parts.push(`${completed} completed`);
    }

    if (failed > 0) {
        parts.push(`${failed} failed`);
    }

    if (stopped > 0) {
        parts.push(`${stopped} stopped`);
    }

    const activeJob = getLatestRunningJob(jobs);

    if (activeJob) {
        parts.push(
            truncateCommand(activeJob.command, 60),
        );
    }

    ctx.ui.setWidget(
        WIDGET_ID,
        [`  Shells · ${parts.join(" · ")}`],
        {
            placement: "belowEditor",
        },
    );
}

export function clearShellDock(
    ctx: ExtensionContext,
): void {
    if (!ctx.hasUI) {
        return;
    }

    ctx.ui.setWidget(WIDGET_ID, undefined);
}