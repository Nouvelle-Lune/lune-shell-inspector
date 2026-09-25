import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shellManager } from "./shell-manager.ts";


const WIDGET_ID = "lune-shell-inspector";
const PADDING = "";

export class ShellDock {
    private refreshTimer: ReturnType<typeof setInterval> | undefined;
    private selected = false;
    private ctx: ExtensionContext | undefined;

    constructor() { };

    private syncRefreshTimer(): void {
        const hasRunningJobs = shellManager.jobsStatusStat.runningCount > 0;

        if (hasRunningJobs && !this.refreshTimer) {
            this.refreshTimer = setInterval(() => {
                this.render();
            }, 1000);
        }

        if (!hasRunningJobs && this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    setCtx(ctx: ExtensionContext): void {
        this.ctx = ctx;
    }

    setSelected(selected: boolean): void {
        if (this.selected === selected) {
            return;
        }

        this.selected = selected;
        this.render();
    }

    isSelected(): boolean {
        return this.selected;
    }

    render(): void {
        if (!this.ctx || !this.ctx.hasUI) { return; }

        this.syncRefreshTimer();

        const jobs = shellManager.getAllJobsList();

        if (jobs.length === 0) {
            this.selected = false;
            this.ctx.ui.setWidget(WIDGET_ID, undefined);
            return;
        }

        const summary = shellDockSummary(this.ctx);

        this.ctx.ui.setWidget(
            WIDGET_ID,
            [
                `${PADDING}${summary}${this.ctx.ui.theme.fg("dim", " · /shell to open")}`,
            ],
            {
                placement: "belowEditor",
            },
        );
    }

    clear(): void {
        // Stopping the timer is independent of the UI: a session that ends must not keep
        // rendering through its refresh interval.
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }

        if (!this.ctx || !this.ctx.hasUI) { return; }

        this.selected = false;
        this.ctx.ui.setWidget(WIDGET_ID, undefined);
    }
}

function shellDockSummary(ctx: ExtensionContext): string {
    const status = shellManager.getAllJobsStatusStat();

    // only one running shell case
    if (
        status.runningCount === 1 &&
        status.completedCount === 0 &&
        status.failedCount === 0 &&
        status.killedCount === 0
    ) {
        const runningJob = shellManager.getRunningJobsList()[0];
        const elapsedTime = Math.floor((Date.now() - runningJob!.startedAt) / 1000);
        return [
            ctx.ui.theme.fg("accent", `${status.runningCount} running shell`),
            truncateOutput(runningJob!.command, 20),
            `${elapsedTime}s`,
        ].join(ctx.ui.theme.fg("dim", " · "));
    }
    // only one completed shell case
    if (status.completedCount === 1 && status.runningCount === 0 && status.failedCount === 0 && status.killedCount === 0) {
        const completedJob = shellManager.getCompletedJobsList()[0];
        const elapsedTime = Math.floor((completedJob!.finishedAt! - completedJob!.startedAt) / 1000);
        return (ctx.ui.theme.fg("success", `${status.completedCount} shell completed`) + ` in ${elapsedTime}s`);
    }

    const parts: string[] = [];
    const jobCount = shellManager.getAllJobsList().length;
    parts.push(`${jobCount} ${jobCount === 1 ? "shell" : "shells"}`);

    if (status.runningCount > 0) {
        parts.push(ctx.ui.theme.fg("accent", `${status.runningCount} running`));
    }
    if (status.completedCount > 0) {
        parts.push(ctx.ui.theme.fg("success", `${status.completedCount} completed`));
    }
    if (status.failedCount > 0) {
        parts.push(ctx.ui.theme.fg("error", `${status.failedCount} failed`));
    }
    if (status.killedCount > 0) {
        parts.push(ctx.ui.theme.fg("error", `${status.killedCount} killed`));
    }

    return `${parts.join(ctx.ui.theme.fg("dim", " · "))}`;
}

function truncateOutput(output: string, maxLength: number): string {
    if (output.length <= maxLength) {
        return output;
    }
    return output.slice(0, maxLength) + "...";
}

export const shellDock = new ShellDock();