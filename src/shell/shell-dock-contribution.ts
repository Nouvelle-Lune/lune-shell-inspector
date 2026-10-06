import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { createDockContribution, type LuneDockSnapshot } from "@nouvelle-lune/lune-dock-protocol";
import { shellDock } from "./shell-dock.ts";
import { collapseShellCommand } from "./shell-command.ts";
import { openShellInspector } from "./shell-inspector.ts";
import { shellManager, type ShellManagerEvent } from "./shell-manager.ts";

export const SHELL_CONTRIBUTION_ID = "shell-inspector";

export class ShellDockContribution {
    private generation = 0;
    private readonly acknowledged = new Set<string>();
    private ctx: ExtensionContext | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private readonly dock = createDockContribution({
        id: SHELL_CONTRIBUTION_ID,
        getSnapshot: (ctx) => this.getSnapshot(ctx),
        activate: (ctx) => this.open(ctx),
        standalone: shellDock,
    });

    attach(ctx: ExtensionContext): void {
        this.detach({ retired: true });
        this.ctx = ctx;
        this.dock.attach(ctx);
        this.syncTimer();
    }

    detach(options?: { retired?: boolean }): void {
        this.generation++;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.ctx = undefined;
        this.dock.detach(options);
        this.acknowledged.clear();
    }

    onManagerEvent(event: ShellManagerEvent): void {
        if (event.type === "jobs-cleared") this.acknowledged.clear();
        if (event.type === "job-cleared") this.acknowledged.delete(event.id);
        // Output chunks affect the independent command/runtime row, not the shared summary.
        this.dock.refresh({ summaryChanged: event.type !== "output-updated" });
        this.syncTimer();
    }

    render(): void {
        this.dock.refresh();
    }

    private syncTimer(): void {
        if (this.ctx?.mode === "tui" && shellManager.getRunningJobsList().length > 0) {
            this.timer ??= setInterval(() => this.render(), 1000);
        } else if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    getSnapshot(ctx = this.ctx!): LuneDockSnapshot {
        const jobs = shellManager.getAllJobsList();
        const failed = jobs.filter((job) => job.status === "failed" || job.status === "killed");
        const running = jobs.filter((job) => job.status === "running");
        let color: ThemeColor;
        let marker: string;
        if (failed.some((job) => !this.acknowledged.has(job.id))) { color = "error"; marker = "✕"; }
        else if (running.length > 0) { color = "warning"; marker = "◐"; }
        else if (jobs.some((job) => job.status === "completed")) { color = "success"; marker = "●"; }
        else if (jobs.length > 0) { color = "error"; marker = "✕"; }
        else { color = "dim"; marker = "○"; }
        const summary = jobs.length === 0 ? "idle" : [
            running.length > 0 ? `${running.length} running` : undefined,
            jobs.filter((job) => job.status === "completed").length > 0 ? `${jobs.filter((job) => job.status === "completed").length} completed` : undefined,
            failed.length > 0 ? `${failed.length} failed/killed` : undefined,
        ].filter(Boolean).join(" · ");
        const latest = jobs[jobs.length - 1];
        const command = latest ? collapseShellCommand(latest.command) : undefined;
        const elapsed = latest ? Math.floor(((latest.finishedAt ?? Date.now()) - latest.startedAt) / 1000) : undefined;
        const component = (suffix: string): Component => ({
            render: (width) => [truncateToWidth(
                `${ctx.ui.theme.fg(color, marker)} Shell${suffix ? ctx.ui.theme.fg("muted", ` · ${suffix}`) : ""}`,
                width,
            )],
            invalidate() {},
        });
        return {
            base: component(""),
            detail: component(summary),
            full: component([summary, command ? `latest: ${command}` : undefined, elapsed !== undefined ? `${elapsed}s` : undefined].filter(Boolean).join(" · ")),
        };
    }

    async open(ctx: ExtensionContext): Promise<void> {
        const generation = this.generation;
        // A failure arriving after the panel opened has not necessarily been seen. Only
        // the opening snapshot is acknowledged, and only after a successful interaction.
        const seen = shellManager.getAllJobsList()
            .filter((job) => job.status === "failed" || job.status === "killed")
            .map((job) => job.id);
        await openShellInspector(ctx);
        if (generation !== this.generation) return;
        for (const id of seen) this.acknowledged.add(id);
        this.render();
    }
}
