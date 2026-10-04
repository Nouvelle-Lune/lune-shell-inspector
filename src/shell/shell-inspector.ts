import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import {
    Key,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
    type TuiMouseEvent,
    type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { shellManager, type ShellJob, type ShellJobStatus } from "./shell-manager.ts";
import { formatShellCommand } from "./shell-command.ts";

type ThemeColor = Parameters<Theme["fg"]>[0];

const LEFT_PANE_RATIO = 0.31;
const LEFT_PANE_MIN_WIDTH = 22;
const LEFT_PANE_MAX_WIDTH = 40;
const RIGHT_PANE_MIN_WIDTH = 28;

// The overlay only caps itself at 75% of the terminal, so the body height has
// to leave room for the six frame lines (top, header, two separators, footer,
// bottom) or the frame gets clipped on short terminals.
const OVERLAY_HEIGHT_RATIO = 0.75;
const FRAME_HEIGHT = 6;
const BODY_MIN_HEIGHT = 8;
const BODY_MAX_HEIGHT = 18;
// Top border, header and the separator above the panes.
const BODY_TOP = 3;

const FOOTER_NOTICE_DURATION_MS = 1800;

const BACK_TO_BOTTOM_LABEL = "[ ↓ Back to bottom · End ]";

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

export class ShellInspector implements Component {
    private readonly ctx: ExtensionContext;
    private readonly requestRender: () => void;
    private readonly close: () => void;
    private readonly terminalRows: () => number;
    private readonly theme: Theme;

    private selectedIndex = 0;
    private unsubscribeJobs: (() => void) | undefined;
    private refreshTimer: ReturnType<typeof setInterval> | undefined;

    /**
     * First visible wrapped output row; undefined follows the newest output.
     *
     * An absolute anchor (not an offset from the tail) is what makes scrolling a pause: with a
     * tail-relative offset, streamed lines would drag the viewport along while the user reads.
     */
    private outputAnchor: number | undefined;
    /** Output rows the last render could show; key handling needs it to clamp the anchor. */
    private outputRows = 0;
    private outputWidth = 1;

    /**
     * Pane layout of the last frame. Mouse events arrive as overlay-local cells, so hit-testing
     * has to use the geometry the user actually sees rather than recompute it from a new width.
     */
    private paneLayout:
        | {
              bodyHeight: number;
              rightStart: number;
              listStart: number;
              /** Columns of the back-to-bottom label on the bottom separator, while one is drawn. */
              backToBottom?: { start: number; end: number };
          }
        | undefined;

    /** Footer notice to display messages at the bottom of the inspector. */
    private footerNotice: { text: string; color: ThemeColor } | undefined;
    private footerNoticeTimer: ReturnType<typeof setTimeout> | undefined;

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
            if (!chosenJob) {
                return;
            }
            shellManager.settleJob(chosenJob.id, {
                type: "killed",
                error: "Shell killed by user",
            });
            return;
        }

        if (data === "c") {
            const chosenJob = jobs[this.selectedIndex];

            if (!chosenJob) {
                return;
            }

            const cleared = shellManager.clearJob(chosenJob.id);

            if (cleared) {
                this.outputAnchor = undefined;
                this.showFooterNotice(
                    `Cleared ${formatShellCommand(chosenJob.label ?? chosenJob.command, 28)}`,
                    "success",
                );
            } else {
                this.showFooterNotice(`Clear failed, only completed, failed, or killed`, "accent");
            }
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

        const scrollStep =
            matchesKey(data, Key.shift("up")) || matchesKey(data, Key.shift("k"))
                ? -1
                : matchesKey(data, Key.shift("down")) || matchesKey(data, Key.shift("j"))
                  ? 1
                  : 0;

        if (scrollStep !== 0) {
            this.scrollOutput(scrollStep);
            return;
        }

        const step =
            matchesKey(data, Key.down) || data === "j"
                ? 1
                : matchesKey(data, Key.up) || data === "k"
                  ? -1
                  : 0;

        this.moveSelection(step);
    }

    /**
     * Fullscreen mode routes the mouse here; regular mode leaves it to the terminal, so every
     * action below also has a key.
     */
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        const layout = this.paneLayout;

        if (!layout) {
            return undefined;
        }

        if (event.type === "wheel") {
            const delta = event.wheelDelta ?? 0;

            if (event.x >= layout.rightStart) {
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
            event.y === BODY_TOP + layout.bodyHeight &&
            event.x >= label.start &&
            event.x < label.end
        ) {
            this.followNewestLine();

            return { handled: true };
        }

        const row = event.y - BODY_TOP;
        const index = layout.listStart + row;

        if (
            event.x < 1 ||
            event.x >= layout.rightStart - 1 ||
            row < 0 ||
            row >= layout.bodyHeight ||
            index >= shellManager.getAllJobsList().length
        ) {
            return undefined;
        }

        this.selectJob(index);

        return { handled: true };
    }

    private moveSelection(step: number): void {
        const jobs = shellManager.getAllJobsList();

        if (jobs.length === 0 || step === 0) {
            return;
        }

        this.selectJob(Math.min(jobs.length - 1, Math.max(0, this.selectedIndex + step)));
    }

    private selectJob(index: number): void {
        if (index === this.selectedIndex) {
            return;
        }

        this.selectedIndex = index;
        shellManager.setInspectorIndex(index);

        // A different job has a different output; reading it from the middle would be confusing.
        this.outputAnchor = undefined;

        this.requestRender();
    }

    render(width: number): string[] {
        const jobs = shellManager.getAllJobsList();

        this.syncRefreshTimer();

        if (jobs.length === 0) {
            this.selectedIndex = 0;
            this.outputAnchor = undefined;
            this.outputRows = 0;
        } else {
            this.selectedIndex = Math.min(this.selectedIndex, jobs.length - 1);
        }

        // The clamped index is what the user sees, so it is also what a later reopen should restore.
        shellManager.setInspectorIndex(this.selectedIndex);

        const bodyHeight = this.bodyHeight();

        const innerWidth = Math.max(
            LEFT_PANE_MIN_WIDTH + RIGHT_PANE_MIN_WIDTH + 1,
            width - 2, // Leave one column for each frame border: │ content │
        );

        const leftWidth = Math.min(
            LEFT_PANE_MAX_WIDTH,
            Math.max(LEFT_PANE_MIN_WIDTH, Math.round(innerWidth * LEFT_PANE_RATIO)),
            innerWidth - RIGHT_PANE_MIN_WIDTH - 1,
        );

        const rightWidth = innerWidth - leftWidth - 1; // Leave one column for the separator: │ left │ right │
        /**
         * Render the left pane with the list of jobs.
         * › ● npm test                    running
         *   ● npm example bash ...        running
         */
        const hasJobs = jobs.length > 0;

        const listStart = Math.min(
            Math.max(0, this.selectedIndex - Math.floor(bodyHeight / 2)),
            Math.max(0, jobs.length - bodyHeight),
        );

        // Columns: │ left │ right │
        this.paneLayout = { bodyHeight, rightStart: leftWidth + 2, listStart };

        const left = hasJobs
            ? this.renderJobs(jobs, leftWidth, bodyHeight, listStart)
            : this.fill(
                  [this.cell(this.theme.fg("muted", "No background shell running"), leftWidth)],
                  leftWidth,
                  bodyHeight,
              );
        /**
         * Render the right pane with the details of the selected job.
         */
        const right = hasJobs
            ? this.renderDetails(jobs[this.selectedIndex]!, rightWidth, bodyHeight)
            : this.fill([], rightWidth, bodyHeight);

        const lines: string[] = [
            this.frame(`┌${"─".repeat(innerWidth)}┐`),
            this.frame("│") + this.renderHeader(innerWidth) + this.frame("│"),
            this.frame(`├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`),
        ];

        for (let i = 0; i < bodyHeight; i++) {
            lines.push(
                this.frame("│") +
                    this.pad(left[i] ?? "", leftWidth) +
                    this.frame("│") +
                    this.pad(right[i] ?? "", rightWidth) +
                    this.frame("│"),
            );
        }

        lines.push(
            this.renderBottomSeparator(leftWidth, rightWidth, hasJobs),
            this.frame("│") + this.renderFooter(innerWidth) + this.frame("│"),
            this.frame(`└${"─".repeat(innerWidth)}┘`),
        );

        return lines;
    }

    invalidate(): void {}

    /**
     * The separator under the panes; while the output is paused it carries a clickable
     * back-to-bottom label centred under the right pane, so the label never covers output.
     */
    private renderBottomSeparator(leftWidth: number, rightWidth: number, hasJobs: boolean): string {
        const layout = this.paneLayout!;
        const labelWidth = visibleWidth(BACK_TO_BOTTOM_LABEL);
        const paused = hasJobs && this.outputAnchor !== undefined;

        // Keep at least one dash on each side so the label still reads as part of the frame.
        if (!paused || rightWidth < labelWidth + 2) {
            layout.backToBottom = undefined;

            return this.frame(`├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`);
        }

        const before = Math.floor((rightWidth - labelWidth) / 2);
        const after = rightWidth - labelWidth - before;
        const start = layout.rightStart + before;

        layout.backToBottom = { start, end: start + labelWidth };

        return (
            this.frame(`├${"─".repeat(leftWidth)}┴${"─".repeat(before)}`) +
            this.theme.fg("accent", BACK_TO_BOTTOM_LABEL) +
            this.frame(`${"─".repeat(after)}┤`)
        );
    }

    /** Called by the overlay on teardown, and by the Esc path before closing. */
    dispose(): void {
        // Both resources outlive the component unless someone releases them:
        // the timer would otherwise keep rendering into a disposed TUI.
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }

        if (this.footerNoticeTimer) {
            clearTimeout(this.footerNoticeTimer);
            this.footerNoticeTimer = undefined;
        }

        this.unsubscribeJobs?.();
        this.unsubscribeJobs = undefined;
    }

    /** Calculate the height of shell inspector. */
    private bodyHeight(): number {
        return Math.min(
            BODY_MAX_HEIGHT,
            Math.max(
                BODY_MIN_HEIGHT,
                Math.floor(this.terminalRows() * OVERLAY_HEIGHT_RATIO) - FRAME_HEIGHT,
            ),
        );
    }

    private renderHeader(width: number): string {
        // Everything below goes through this.cell(), so every budget is one
        // padded cell wide: the pane width minus the two padding columns.
        const contentWidth = width - 2;

        const title = this.theme.bold("Shell inspector");

        const status = this.renderHeaderStatus(Math.max(0, contentWidth - visibleWidth(title) - 1));

        return this.cell(
            title +
                " ".repeat(Math.max(1, contentWidth - visibleWidth(title) - visibleWidth(status))) +
                status,
            width,
        );
    }

    private renderHeaderStatus(maxWidth: number): string {
        const total = shellManager.getAllJobsList().length;
        const running = shellManager.jobsStatusStat.runningCount;
        const shells = `${total} ${total === 1 ? "shell" : "shells"}`;

        const text =
            this.theme.fg("muted", shells) +
            (running > 0 ? this.theme.fg("accent", ` · ${running} running`) : "");

        return truncateToWidth(text, maxWidth, "…");
    }

    /** Show a temporary notice in the footer with the specified text and color. */
    private showFooterNotice(text: string, color: ThemeColor): void {
        this.footerNotice = { text, color };

        if (this.footerNoticeTimer) {
            clearTimeout(this.footerNoticeTimer);
        }

        this.footerNoticeTimer = setTimeout(() => {
            this.footerNotice = undefined;
            this.footerNoticeTimer = undefined;
            this.requestRender();
        }, FOOTER_NOTICE_DURATION_MS);

        this.requestRender();
    }

    /** Render the footer of the shell inspector. */
    private renderFooter(width: number): string {
        if (this.footerNotice) {
            return this.cell(this.theme.fg(this.footerNotice.color, this.footerNotice.text), width);
        }

        return this.cell(
            this.theme.fg(
                "dim",
                "↑↓/jk shell · ⇧↑↓/jk scroll · Home/End · x to kill · c to clear · Esc to close",
            ),
            width,
        );
    }

    private renderJobs(
        jobs: readonly Readonly<ShellJob>[],
        width: number,
        bodyHeight: number,
        start: number,
    ): string[] {
        const contentWidth = width - 2;

        const rows: string[] = [];

        for (const [index, job] of jobs.entries()) {
            if (index < start) {
                continue;
            }

            if (index >= start + bodyHeight) {
                break;
            }

            const color = statusColor(job.status);
            const status = this.theme.fg(color, job.status);
            const selected = index === this.selectedIndex;

            // Four columns go to the cursor and the status dot; the name then
            // reserves a gap column so it never touches the status text.
            const nameWidth = Math.max(4, contentWidth - 5 - visibleWidth(status));

            const name = selected
                ? this.theme.bold(formatShellCommand(job.label ?? job.command, nameWidth))
                : formatShellCommand(job.label ?? job.command, nameWidth);

            const gap = Math.max(1, contentWidth - 4 - visibleWidth(name) - visibleWidth(status));

            rows.push(
                this.cell(
                    (selected ? this.theme.fg("accent", "›") : " ") +
                        ` ${this.theme.fg(color, "●")} ${name}` +
                        `${" ".repeat(gap)}${status}`,
                    width,
                ),
            );
        }

        return this.fill(rows, width, bodyHeight);
    }

    private renderDetails(job: Readonly<ShellJob>, width: number, bodyHeight: number): string[] {
        const contentWidth = width - 2;

        const color = statusColor(job.status);

        const command = this.theme.bold(
            formatShellCommand(job.command, Math.max(4, contentWidth - 2)),
        );

        const rows: string[] = [
            this.cell(`${this.theme.fg(color, "●")} ${command}`, width),
            ...this.wrap(
                this.theme.fg(color, job.status) + this.theme.fg("muted", ` · ${jobMeta(job)}`),
                contentWidth,
            ),
        ];

        if (job.error) {
            rows.push(...this.wrap(`Error: ${job.error}`, contentWidth, "error"));
        }

        this.outputWidth = contentWidth;
        const screen = shellManager.getScreenLines(job.id);
        const output = this.wrapOutput(screen);

        // The blank line and the Output header stay fixed, so the scrolling window gets what is
        // left of the body.
        const available = Math.max(0, bodyHeight - rows.length - 2);
        const window = this.outputWindow(output.length, available);

        const header = [
            this.theme.bold("Output"),
            this.theme.fg("muted", ` · ${screen.length} ${screen.length === 1 ? "line" : "lines"}`),
        ];

        if (window.newestHidden > 0) {
            header.push(this.theme.fg("warning", ` · paused ↑${window.newestHidden}`));
        }

        rows.push(this.cell("", width), this.cell(header.join(""), width));

        if (output.length === 0) {
            rows.push(
                this.cell(
                    this.theme.fg(
                        "muted",
                        job.status === "running" ? "no output yet" : "no output",
                    ),
                    width,
                ),
            );
        } else if (window.count > 0) {
            const visible = output.slice(window.start, window.start + window.count);

            for (const line of visible) {
                rows.push(this.cell(line, width));
            }
        }

        return this.fill(rows, width, bodyHeight);
    }

    /**
     * Moves the output pane by `step` wrapped rows, entering pause mode from the tail and leaving it again
     * once the newest line is back in view.
     */
    private scrollOutput(step: number): void {
        const job = this.selectedJob();

        if (!job || this.outputRows === 0) {
            return;
        }

        const lineCount = this.wrapOutput(shellManager.getScreenLines(job.id)).length;
        const tailStart = Math.max(0, lineCount - this.outputRows);

        if (this.outputAnchor === undefined) {
            if (step > 0) {
                return;
            }

            this.outputAnchor = Math.max(0, tailStart + step);
        } else {
            this.outputAnchor = Math.min(tailStart, Math.max(0, this.outputAnchor + step));
        }

        if (this.outputAnchor >= tailStart) {
            this.outputAnchor = undefined;
        }

        this.requestRender();
    }

    private wrapOutput(lines: string[]): string[] {
        // Scroll coordinates must use the same visual rows as the last rendered pane.
        return lines.flatMap((line) =>
            line === "" ? [""] : wrapTextWithAnsi(line, this.outputWidth),
        );
    }

    private jumpToOldestLine(): void {
        this.outputAnchor = 0;

        this.requestRender();
    }

    private followNewestLine(): void {
        this.outputAnchor = undefined;

        this.requestRender();
    }

    private selectedJob(): Readonly<ShellJob> | undefined {
        return shellManager.getAllJobsList()[this.selectedIndex];
    }

    /**
     * Visible slice of the output, clamped to what the body can show. The clamped anchor is stored
     * back so the position stays valid when the output shrinks or the pane is resized.
     */
    private outputWindow(
        lineCount: number,
        available: number,
    ): { start: number; count: number; newestHidden: number } {
        this.outputRows = available;

        const tailStart = Math.max(0, lineCount - available);

        const start =
            this.outputAnchor === undefined ? tailStart : Math.min(this.outputAnchor, tailStart);

        // Landing on the newest line means following it again.
        this.outputAnchor = start >= tailStart ? undefined : start;

        return {
            start,
            count: Math.min(available, lineCount - start),
            newestHidden: Math.max(0, lineCount - (start + available)),
        };
    }

    private syncRefreshTimer(): void {
        const hasRunningJobs = shellManager.jobsStatusStat.runningCount > 0;

        if (hasRunningJobs && !this.refreshTimer) {
            this.refreshTimer = setInterval(() => {
                this.requestRender();
            }, 1000);
        }

        if (!hasRunningJobs && this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private frame(text: string): string {
        return this.theme.fg("border", text);
    }

    private cell(text: string, width: number): string {
        return ` ${truncateToWidth(text, Math.max(0, width - 2), "…", true)} `;
    }

    private pad(text: string, width: number): string {
        return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
    }

    private fill(rows: string[], width: number, bodyHeight: number): string[] {
        while (rows.length < bodyHeight) {
            rows.push(" ".repeat(width));
        }

        return rows.slice(0, bodyHeight);
    }

    private wrap(text: string, width: number, color?: ThemeColor): string[] {
        return wrapTextWithAnsi(text, width).map((line) =>
            color ? this.theme.fg(color, line) : line,
        );
    }
}

function statusColor(status: ShellJobStatus): ThemeColor {
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

function jobMeta(job: Readonly<ShellJob>): string {
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
