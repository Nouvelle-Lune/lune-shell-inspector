import type { MessageRenderOptions, Theme, ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";

import {
    sliceByColumn,
    stripTerminalSequences,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
} from "@earendil-works/pi-tui";

import { collapseShellCommand } from "./shell-command.ts";
import type {
    BackgroundShellNotificationDetails,
    BackgroundShellNotificationJobDetails,
} from "./shell-notification.ts";

/** Visual output lines a collapsed job keeps; the rest stay behind the expand hint. */
const PREVIEW_LINES = 5;

/** Columns a job's error and output rows are indented by under its job row. */
const BODY_INDENT = "    ";

/**
 * pi's expand key, written out rather than read from `keyHint()`.
 *
 * That helper colours with the theme module's own global, and jiti hands an extension a separate,
 * uninitialized copy of it - the same reason pi's own `DynamicBorder` takes an explicit colour.
 */
const EXPAND_KEY = "ctrl+o";

/**
 * Render one batched notification as a tool-result band: a status header, one row per settled job
 * and the tail of each job's output.
 *
 * Returns undefined for a message without jobs, which leaves the row to pi's own custom-message
 * rendering instead of drawing an empty band.
 */
export function renderBackgroundShellNotificationBox(
    message: { content: unknown; details?: BackgroundShellNotificationDetails },
    options: MessageRenderOptions,
    theme: Theme,
): Component | undefined {
    const jobs = message.details?.jobs;

    if (!Array.isArray(jobs) || jobs.length === 0) {
        return undefined;
    }

    return new BackgroundShellNotificationBox(
        jobs,
        typeof message.content === "string" ? message.content : "",
        options,
        theme,
    );
}

/**
 * Transcript band of one batched notification.
 *
 * The band is composed line by line instead of nesting `Text` in `Box` because every row has to be
 * wrapped against the width left after the band padding and the body indent, and that width is only
 * known in `render()`. Lines are cached per width: the transcript renders the box on every frame
 * while other output streams, and pi rebuilds the component on each expand or padding change.
 */
class BackgroundShellNotificationBox implements Component {
    private readonly jobs: readonly BackgroundShellNotificationJobDetails[];
    private readonly content: string;
    private readonly expanded: boolean;
    private readonly paddingX: number;
    private readonly theme: Theme;

    private cachedWidth: number | undefined;
    private cachedLines: string[] | undefined;

    constructor(
        jobs: readonly BackgroundShellNotificationJobDetails[],
        content: string,
        options: MessageRenderOptions,
        theme: Theme,
    ) {
        this.jobs = jobs;
        this.content = content;
        this.expanded = options.expanded;
        this.paddingX = Math.max(0, options.outputPad);
        this.theme = theme;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }

    render(width: number): string[] {
        if (this.cachedLines !== undefined && this.cachedWidth === width) {
            return this.cachedLines;
        }

        const lines = this.buildLines(width);

        this.cachedWidth = width;
        this.cachedLines = lines;

        return lines;
    }

    private buildLines(width: number): string[] {
        // A band wider than the transcript cannot be drawn; pi's Text caps its own padding the same way.
        const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
        const inner = Math.max(1, width - paddingX * 2);
        const bodyWidth = Math.max(1, inner - BODY_INDENT.length);
        const color = this.bandColor();

        const rows: string[] = [
            `${this.theme.fg(color, "●")} ${this.theme.bold(this.theme.fg(color, this.headerText()))}`,
        ];

        for (const job of this.jobs) {
            rows.push(this.jobRow(job, inner));

            if (job.error) {
                rows.push(...this.bodyRows(`Error: ${job.error}`, bodyWidth, "error"));
            }

            rows.push(...this.outputRows(job, bodyWidth));
        }

        // One blank band row above and below, like pi's tool result box.
        return ["", ...rows, ""].map((row) => this.band(row, inner, paddingX));
    }

    /** `<n> background shells settled` / `… failed`, coloured by the batch's worst outcome. */
    private headerText(): string {
        const total = this.jobs.length;
        const failed = this.jobs.filter((job) => job.status !== "completed").length;
        const shells = `${total} background shell${total === 1 ? "" : "s"}`;

        if (failed === 0) {
            return `${shells} settled`;
        }

        if (failed === total) {
            return `${shells} failed`;
        }

        return `${shells} · ${failed} failed`;
    }

    /** Job row: `<command> · <status> · exit <code> · <duration>`. */
    private jobRow(job: BackgroundShellNotificationJobDetails, width: number): string {
        const color = statusColor(job.status);
        const outcome = [
            this.theme.fg(color, job.status),
            job.exitCode === undefined ? undefined : this.theme.fg(color, `exit ${job.exitCode}`),
            job.durationMs === undefined ? undefined : this.theme.fg("muted", formatDuration(job.durationMs)),
        ].filter((part): part is string => part !== undefined);

        // Every outcome part is preceded by a separator, so the command gets what is left after all
        // of them: a long command can never push the status out of the row.
        const separator = this.theme.fg("dim", " · ");
        const outcomeWidth = outcome.reduce((total, part) => total + visibleWidth(part), 0)
            + outcome.length * visibleWidth(separator);
        const commandWidth = Math.max(0, width - outcomeWidth);
        const command = this.theme.fg("text", clipToWidth(collapseShellCommand(job.command), commandWidth));

        return [command, ...outcome].join(separator);
    }

    /** Output tail of one job, with the expand hint while lines stay hidden. */
    private outputRows(job: BackgroundShellNotificationJobDetails, width: number): string[] {
        const output = this.outputText(job);

        if (output.length === 0) {
            return [];
        }

        const lines = output
            .split("\n")
            .map(displayLine)
            .flatMap((line) => wrapTextWithAnsi(line, width));

        while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
            lines.pop();
        }

        const shown = this.expanded ? lines : lines.slice(-PREVIEW_LINES);
        const hidden = lines.length - shown.length;
        const rows = shown.map((line) => BODY_INDENT + this.theme.fg("toolOutput", line));

        if (hidden > 0) {
            rows.push(BODY_INDENT + this.theme.fg("muted", `… ${hidden} earlier lines · ${EXPAND_KEY} to expand`));
        }

        return rows;
    }

    /**
     * The job's output as the message content holds it.
     *
     * Details carry the slice, never the text; an entry whose details predate the box has no slice at
     * all, and both cases end in an empty body rather than a wrong one.
     */
    private outputText(job: BackgroundShellNotificationJobDetails): string {
        const slice = job.output;

        if (!slice) {
            return "";
        }

        const start = Math.max(0, Math.min(slice.start, this.content.length));
        const end = Math.max(start, Math.min(slice.end, this.content.length));

        return stripTerminalSequences(this.content.slice(start, end));
    }

    private bodyRows(text: string, width: number, color: ThemeColor): string[] {
        return wrapTextWithAnsi(text, width).map((line) => BODY_INDENT + this.theme.fg(color, line));
    }

    private band(row: string, inner: number, paddingX: number): string {
        const margin = " ".repeat(paddingX);
        const fill = " ".repeat(Math.max(0, inner - visibleWidth(row)));

        return this.theme.bg(this.bandToken(), `${margin}${row}${fill}${margin}`);
    }

    private bandColor(): ThemeColor {
        return this.bandToken() === "toolErrorBg" ? "error" : "success";
    }

    private bandToken(): ThemeBg {
        return this.jobs.some((job) => job.status !== "completed") ? "toolErrorBg" : "toolSuccessBg";
    }
}

/**
 * Clip one plain line to the columns a row has left.
 *
 * `truncateToWidth` is deliberately not used here: it closes a cut with a full `\x1b[0m`, which
 * drops the band's background from everything after the ellipsis.
 */
function clipToWidth(text: string, width: number): string {
    const ellipsis = "…";

    if (width <= 0) {
        return "";
    }

    if (visibleWidth(text) <= width) {
        return text;
    }

    const ellipsisWidth = visibleWidth(ellipsis);

    if (width <= ellipsisWidth) {
        return sliceByColumn(ellipsis, 0, width, true);
    }

    return `${sliceByColumn(text, 0, width - ellipsisWidth, true)}${ellipsis}`;
}

function statusColor(status: string): ThemeColor {
    return status === "completed" ? "success" : "error";
}

/** `4.2s` / `1m 4s` / `1h 2m`, matching the wording pi's own tool boxes use. */
function formatDuration(ms: number): string {
    const seconds = ms / 1000;

    if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
    }

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);

    if (minutes < 60) {
        return `${minutes}m ${totalSeconds % 60}s`;
    }

    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One output line as a terminal would end up showing it.
 *
 * A carriage return repaints the line from column 0, so only the last segment is left on screen; a
 * trailing one is the CR of a CRLF pair and keeps the segment before it. Tabs are expanded like
 * pi's `Text` does, because the band measures and wraps in terminal cells.
 */
function displayLine(line: string): string {
    const segments = line.split("\r");

    for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index]!;

        if (segment.length > 0) {
            return segment.replace(/\t/g, "   ");
        }
    }

    return "";
}
