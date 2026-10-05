import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { cell, pad } from "./cells.ts";
import type { PaneGeometry } from "./geometry.ts";
import type { Notice } from "./footer-notice.ts";

const BACK_TO_BOTTOM_LABEL = "[ ↓ Back to bottom · End ]";
const BACK_TO_BOTTOM_LABEL_WIDTH = visibleWidth(BACK_TO_BOTTOM_LABEL);

const KEY_HINTS =
    "↑↓/jk shell · ⇧↑↓/jk scroll · Home/End · x to kill · c to clear · Esc to close";

function border(theme: Theme, text: string): string {
    return theme.fg("border", text);
}

export function renderHeader(
    theme: Theme,
    width: number,
    totalJobs: number,
    runningJobs: number,
): string {
    // Everything goes through cell(), so every budget is the pane width minus its two padding columns.
    const contentWidth = width - 2;
    const title = theme.bold("Shell inspector");

    const shells = `${totalJobs} ${totalJobs === 1 ? "shell" : "shells"}`;
    const status = truncateToWidth(
        theme.fg("muted", shells) +
            (runningJobs > 0 ? theme.fg("accent", ` · ${runningJobs} running`) : ""),
        Math.max(0, contentWidth - visibleWidth(title) - 1),
        "…",
    );

    return cell(
        title +
            " ".repeat(Math.max(1, contentWidth - visibleWidth(title) - visibleWidth(status))) +
            status,
        width,
    );
}

export function renderFooter(theme: Theme, width: number, notice: Notice | undefined): string {
    return cell(
        notice ? theme.fg(notice.color, notice.text) : theme.fg("dim", KEY_HINTS),
        width,
    );
}

export interface BottomSeparator {
    line: string;
    /** Columns of the back-to-bottom label, while one is drawn. */
    label?: { start: number; end: number };
}

/**
 * The separator under the panes; while the output is paused it carries a clickable
 * back-to-bottom label centred under the right pane, so the label never covers output.
 */
export function renderBottomSeparator(
    theme: Theme,
    geometry: PaneGeometry,
    paused: boolean,
): BottomSeparator {
    const { leftWidth, rightWidth, rightStart } = geometry;

    // Keep at least one dash on each side so the label still reads as part of the frame.
    if (!paused || rightWidth < BACK_TO_BOTTOM_LABEL_WIDTH + 2) {
        return { line: border(theme, `├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`) };
    }

    const before = Math.floor((rightWidth - BACK_TO_BOTTOM_LABEL_WIDTH) / 2);
    const after = rightWidth - BACK_TO_BOTTOM_LABEL_WIDTH - before;
    const start = rightStart + before;

    return {
        line:
            border(theme, `├${"─".repeat(leftWidth)}┴${"─".repeat(before)}`) +
            theme.fg("accent", BACK_TO_BOTTOM_LABEL) +
            border(theme, `${"─".repeat(after)}┤`),
        label: { start, end: start + BACK_TO_BOTTOM_LABEL_WIDTH },
    };
}

export interface FrameParts {
    header: string;
    left: readonly string[];
    right: readonly string[];
    separator: string;
    footer: string;
}

export function assembleFrame(theme: Theme, geometry: PaneGeometry, parts: FrameParts): string[] {
    const { bodyHeight, innerWidth, leftWidth, rightWidth } = geometry;
    const edge = border(theme, "│");

    const lines = [
        border(theme, `┌${"─".repeat(innerWidth)}┐`),
        edge + parts.header + edge,
        border(theme, `├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`),
    ];

    for (let row = 0; row < bodyHeight; row++) {
        lines.push(
            edge +
                pad(parts.left[row] ?? "", leftWidth) +
                edge +
                pad(parts.right[row] ?? "", rightWidth) +
                edge,
        );
    }

    lines.push(parts.separator, edge + parts.footer + edge, border(theme, `└${"─".repeat(innerWidth)}┘`));

    return lines;
}
