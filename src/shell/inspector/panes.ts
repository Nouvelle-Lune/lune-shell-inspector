import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ShellJob } from "../shell-manager.ts";
import { cell, fill } from "./cells.ts";
import { jobMeta, statusColor, type CommandPreviews, type ThemeColor } from "./job-format.ts";
import type { WrappedOutput } from "./output-rows.ts";
import type { OutputViewport } from "./output-viewport.ts";
import { paintScrollbar, scrollThumb } from "./scrollbar.ts";

export interface JobListView {
    /** Only the jobs the pane shows, beginning at `start` in the whole list. */
    visibleJobs: readonly Readonly<ShellJob>[];
    start: number;
    totalJobs: number;
    selectedIndex: number;
    showScrollbar: boolean;
}

/**
 * The left pane.
 * › ● npm test                    running
 *   ● npm example bash ...        running
 */
export function renderJobList(
    theme: Theme,
    previews: CommandPreviews,
    view: JobListView,
    width: number,
    height: number,
): string[] {
    const contentWidth = width - 2;

    const rows = view.visibleJobs.map((job, offset) => {
        const color = statusColor(job.status);
        const status = theme.fg(color, job.status);
        const selected = view.start + offset === view.selectedIndex;

        // Four columns go to the cursor and the status dot; the name then
        // reserves a gap column so it never touches the status text.
        const nameWidth = Math.max(4, contentWidth - 5 - visibleWidth(status));
        const preview = previews.fit(job.label ?? job.command, nameWidth);
        const name = selected ? theme.bold(preview) : preview;

        const gap = Math.max(1, contentWidth - 4 - visibleWidth(name) - visibleWidth(status));

        return cell(
            (selected ? theme.fg("accent", "›") : " ") +
                ` ${theme.fg(color, "●")} ${name}` +
                `${" ".repeat(gap)}${status}`,
            width,
        );
    });

    return paintScrollbar(
        theme,
        fill(rows, width, height),
        view.showScrollbar ? scrollThumb(view.start, height, view.totalJobs) : undefined,
    );
}

export function renderEmptyList(theme: Theme, width: number, height: number): string[] {
    return fill([cell(theme.fg("muted", "No background shell running"), width)], width, height);
}

export interface DetailsView {
    job: Readonly<ShellJob>;
    output: WrappedOutput;
    viewport: OutputViewport;
    showScrollbar: boolean;
}

/** The right pane: the selected job's status line, then its output through the viewport. */
export function renderDetails(
    theme: Theme,
    previews: CommandPreviews,
    view: DetailsView,
    width: number,
    height: number,
): string[] {
    const { job, output } = view;
    const contentWidth = width - 2;
    const color = statusColor(job.status);
    const command = theme.bold(previews.fit(job.command, Math.max(4, contentWidth - 2)));

    const rows: string[] = [
        cell(`${theme.fg(color, "●")} ${command}`, width),
        ...wrap(
            theme,
            theme.fg(color, job.status) + theme.fg("muted", ` · ${jobMeta(job)}`),
            contentWidth,
        ),
    ];

    if (job.error) {
        rows.push(...wrap(theme, `Error: ${job.error}`, contentWidth, "error"));
    }

    // The blank line and the Output header stay fixed, so the scrolling window gets what is left.
    const available = Math.max(0, height - rows.length - 2);
    const window = view.viewport.view(output, available, view.showScrollbar);

    const header = [
        theme.bold("Output"),
        theme.fg("muted", ` · ${output.lineCount} ${output.lineCount === 1 ? "line" : "lines"}`),
    ];

    if (window.newestHidden > 0) {
        header.push(theme.fg("warning", ` · paused ↑${window.newestHidden}`));
    }

    rows.push(cell("", width), cell(header.join(""), width));

    if (output.lineCount === 0) {
        rows.push(
            cell(theme.fg("muted", job.status === "running" ? "no output yet" : "no output"), width),
        );
    } else {
        rows.push(
            ...paintScrollbar(
                theme,
                window.rows.map((line) => cell(line, width)),
                window.position && view.showScrollbar
                    ? scrollThumb(window.position.start, available, window.position.total)
                    : undefined,
            ),
        );
    }

    return fill(rows, width, height);
}

function wrap(theme: Theme, text: string, width: number, color?: ThemeColor): string[] {
    return wrapTextWithAnsi(text, width).map((line) => (color ? theme.fg(color, line) : line));
}
