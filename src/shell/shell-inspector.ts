import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import {
    Key,
    matchesKey,
    type Component,
    type TuiMouseEvent,
    type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { FooterNotice } from "./inspector/footer-notice.ts";
import {
    assembleFrame,
    renderBottomSeparator,
    renderFooter,
    renderHeader,
} from "./inspector/frame.ts";
import { BODY_TOP, listWindowStart, paneGeometry, type PaneGeometry } from "./inspector/geometry.ts";
import { CommandPreviews, type ThemeColor } from "./inspector/job-format.ts";
import { OutputRowsCache } from "./inspector/output-rows.ts";
import { OutputViewport } from "./inspector/output-viewport.ts";
import { renderDetails, renderEmptyList, renderJobList } from "./inspector/panes.ts";
import { ScrollbarVisibility } from "./inspector/scrollbar.ts";
import { formatShellCommand } from "./shell-command.ts";
import { shellManager } from "./shell-manager.ts";

const REFRESH_INTERVAL_MS = 1000;

export async function openShellInspector(ctx: ExtensionContext): Promise<void> {
    await ctx.ui.custom<void>(
        (tui, _theme, _keybindings, done) => {
            const inspector = new ShellInspector(
                ctx,
                () => tui.requestRender(),
                () => done(),
                () => tui.terminal.rows,
            );

            return inspector;
        },
        {
            overlay: true,

            overlayOptions: {
                anchor: "center",

                width: "80%",
                minWidth: 70,

                maxHeight: "75%",

                margin: 2,
            },
        },
    );
}

/**
 * Pane layout of the last frame. Mouse events arrive as overlay-local cells, so hit-testing
 * has to use the geometry the user actually sees rather than recompute it from a new width.
 */
interface FrameLayout {
    geometry: PaneGeometry;
    listStart: number;
    /** Columns of the back-to-bottom label on the bottom separator, while one is drawn. */
    backToBottom?: { start: number; end: number };
}

export class ShellInspector implements Component {
    private readonly ctx: ExtensionContext;
    private readonly requestRender: () => void;
    private readonly close: () => void;
    private readonly terminalRows: () => number;
    private readonly theme: Theme;

    private selectedIndex = 0;
    private unsubscribeJobs: (() => void) | undefined;
    private refreshTimer: ReturnType<typeof setInterval> | undefined;

    private readonly viewport = new OutputViewport();
    private readonly outputs = new OutputRowsCache();
    private readonly previews = new CommandPreviews();
    private readonly scrollbars: ScrollbarVisibility;
    private readonly footerNotice: FooterNotice;
    private outputWidth = 1;
    private layout: FrameLayout | undefined;

    constructor(
        ctx: ExtensionContext,
        requestRender: () => void,
        close: () => void,
        terminalRows: () => number = () => 40,
        theme: Theme = ctx.ui.theme,
    ) {
        this.ctx = ctx;
        this.requestRender = requestRender;
        this.close = close;
        this.terminalRows = terminalRows;
        this.theme = theme;

        this.scrollbars = new ScrollbarVisibility(() => this.requestRender());
        this.footerNotice = new FooterNotice(() => this.requestRender());

        // The index is memory-only state on the manager: reopening the overlay resumes the last
        // selection, while a fresh session starts on the first shell.
        this.selectedIndex = shellManager.getInspectorIndex();

        this.unsubscribeJobs = shellManager.subscribe(() => {
            this.syncRefreshTimer();
            this.requestRender();
        });

        this.syncRefreshTimer();
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
            this.dispose();
            this.close();
            return;
        }

        const jobs = shellManager.getAllJobsList();

        if (jobs.length === 0) {
            return;
        }

        if (data === "x") {
            const chosenJob = jobs[this.selectedIndex];

            if (chosenJob) {
                shellManager.settleJob(chosenJob.id, {
                    type: "killed",
                    error: "Shell killed by user",
                });
            }
            return;
        }

        if (data === "c") {
            this.clearSelectedJob(jobs[this.selectedIndex]);
            return;
        }

        if (matchesKey(data, Key.home)) {
            this.jumpToOldestLine();
            return;
        }

        if (matchesKey(data, Key.end)) {
            this.followNewestLine();
            return;
        }

        if (matchesKey(data, Key.shift("up")) || matchesKey(data, Key.shift("k"))) {
            this.scrollOutput(-1);
            return;
        }

        if (matchesKey(data, Key.shift("down")) || matchesKey(data, Key.shift("j"))) {
            this.scrollOutput(1);
            return;
        }

        if (matchesKey(data, Key.down) || data === "j") {
            this.moveSelection(1);
        } else if (matchesKey(data, Key.up) || data === "k") {
            this.moveSelection(-1);
        }
    }

    /**
     * Fullscreen mode routes the mouse here; regular mode leaves it to the terminal, so every
     * action below also has a key.
     */
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        const layout = this.layout;

        if (!layout) {
            return undefined;
        }

        const { bodyHeight, rightStart } = layout.geometry;

        if (event.type === "wheel") {
            const delta = event.wheelDelta ?? 0;

            if (event.x >= rightStart) {
                this.scrollOutput(delta);
            } else {
                this.moveSelection(delta);
            }

            // Unhandled wheel events would fall through to the transcript behind the overlay.
            return { handled: true };
        }

        // Only presses on a job row or the back-to-bottom label are claimed: anything else keeps
        // the TUI's text selection, which is how output gets copied out of the pane.
        if (event.type !== "press" || event.button !== "left") {
            return undefined;
        }

        const label = layout.backToBottom;

        if (
            label &&
            event.y === BODY_TOP + bodyHeight &&
            event.x >= label.start &&
            event.x < label.end
        ) {
            this.followNewestLine();

            return { handled: true };
        }

        const row = event.y - BODY_TOP;
        const index = layout.listStart + row;
        const jobCount = shellManager.getAllJobsList().length;

        if (
            event.x < 1 ||
            event.x >= rightStart - 1 ||
            row < 0 ||
            row >= bodyHeight ||
            index >= jobCount
        ) {
            return undefined;
        }

        this.selectJob(index, jobCount);

        return { handled: true };
    }

    render(width: number): string[] {
        const jobs = shellManager.getAllJobsList();
        const hasJobs = jobs.length > 0;

        this.syncRefreshTimer();

        if (hasJobs) {
            this.selectedIndex = Math.min(this.selectedIndex, jobs.length - 1);
        } else {
            this.selectedIndex = 0;
            this.viewport.reset();
        }

        // The clamped index is what the user sees, so it is also what a later reopen should restore.
        shellManager.setInspectorIndex(this.selectedIndex);

        const geometry = paneGeometry(width, this.terminalRows());
        const { bodyHeight, leftWidth, rightWidth } = geometry;
        const listStart = listWindowStart(this.selectedIndex, jobs.length, bodyHeight);

        const layout: FrameLayout = { geometry, listStart };
        this.layout = layout;

        const left = hasJobs
            ? renderJobList(
                  this.theme,
                  this.previews,
                  {
                      visibleJobs: jobs.slice(listStart, listStart + bodyHeight),
                      start: listStart,
                      totalJobs: jobs.length,
                      selectedIndex: this.selectedIndex,
                      showScrollbar: this.scrollbars.isVisible("jobs"),
                  },
                  leftWidth,
                  bodyHeight,
              )
            : renderEmptyList(this.theme, leftWidth, bodyHeight);

        let right: string[] = [];

        if (hasJobs) {
            const job = jobs[this.selectedIndex]!;

            this.outputWidth = rightWidth - 2;
            right = renderDetails(
                this.theme,
                this.previews,
                {
                    job,
                    output: this.outputs.get(shellManager, job.id, this.outputWidth),
                    viewport: this.viewport,
                    showScrollbar: this.scrollbars.isVisible("output"),
                },
                rightWidth,
                bodyHeight,
            );
        }

        // The details pane clamps the output position, so the separator can only read it afterwards.
        const header = renderHeader(
            this.theme,
            geometry.innerWidth,
            jobs.length,
            shellManager.jobsStatusStat.runningCount,
        );
        const separator = renderBottomSeparator(
            this.theme,
            geometry,
            hasJobs && this.viewport.paused,
        );

        layout.backToBottom = separator.label;

        return assembleFrame(this.theme, geometry, {
            header,
            left,
            right,
            separator: separator.line,
            footer: renderFooter(this.theme, geometry.innerWidth, this.footerNotice.active),
        });
    }

    invalidate(): void {}

    /** Called by the overlay on teardown, and by the Esc path before closing. */
    dispose(): void {
        // Both resources outlive the component unless someone releases them:
        // the timer would otherwise keep rendering into a disposed TUI.
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }

        this.footerNotice.dispose();
        this.scrollbars.dispose();
        this.outputs.clear();
        this.previews.clear();

        this.unsubscribeJobs?.();
        this.unsubscribeJobs = undefined;
    }

    private clearSelectedJob(job: Readonly<{ id: string; label?: string; command: string }> | undefined): void {
        if (!job) {
            return;
        }

        if (shellManager.clearJob(job.id)) {
            this.viewport.follow();
            this.showNotice(`Cleared ${formatShellCommand(job.label ?? job.command, 28)}`, "success");
        } else {
            this.showNotice("Clear failed, only completed, failed, or killed", "accent");
        }
    }

    private showNotice(text: string, color: ThemeColor): void {
        this.footerNotice.show(text, color);
        this.requestRender();
    }

    private moveSelection(step: number): void {
        const jobCount = shellManager.getAllJobsList().length;

        if (jobCount === 0 || step === 0) {
            return;
        }

        this.selectJob(Math.min(jobCount - 1, Math.max(0, this.selectedIndex + step)), jobCount);
    }

    private selectJob(index: number, jobCount: number): void {
        if (index === this.selectedIndex) {
            return;
        }

        this.selectedIndex = index;
        shellManager.setInspectorIndex(index);

        // A different job has a different output; reading it from the middle would be confusing.
        this.viewport.follow();
        this.scrollbars.hide("output");

        if (this.layout && jobCount > this.layout.geometry.bodyHeight) {
            this.scrollbars.show("jobs");
        }

        this.requestRender();
    }

    private scrollOutput(step: number): void {
        const job = shellManager.getAllJobsList()[this.selectedIndex];

        if (!job) {
            return;
        }

        const result = this.viewport.scrollBy(step, () =>
            this.outputs.get(shellManager, job.id, this.outputWidth),
        );

        if (result === "ignored") {
            return;
        }

        if (result === "moved") {
            this.scrollbars.show("output");
        }

        this.requestRender();
    }

    private jumpToOldestLine(): void {
        if (this.viewport.jumpToOldest()) {
            this.scrollbars.show("output");
        }

        this.requestRender();
    }

    private followNewestLine(): void {
        if (this.viewport.follow()) {
            this.scrollbars.show("output");
        }

        this.requestRender();
    }

    private syncRefreshTimer(): void {
        const hasRunningJobs = shellManager.jobsStatusStat.runningCount > 0;

        if (hasRunningJobs && !this.refreshTimer) {
            this.refreshTimer = setInterval(() => {
                this.requestRender();
            }, REFRESH_INTERVAL_MS);
        }

        if (!hasRunningJobs && this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }
}
