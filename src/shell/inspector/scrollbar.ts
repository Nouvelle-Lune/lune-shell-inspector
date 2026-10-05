import type { Theme } from "@earendil-works/pi-coding-agent";

export type ScrollPane = "jobs" | "output";

const HIDE_DELAY_MS = 1000;

/** Scrollbars are transient: a pane's bar stays for a second after it last moved. */
export class ScrollbarVisibility {
    private readonly timers: Partial<Record<ScrollPane, ReturnType<typeof setTimeout>>> = {};
    private readonly onHidden: () => void;

    constructor(onHidden: () => void) {
        this.onHidden = onHidden;
    }

    isVisible(pane: ScrollPane): boolean {
        return this.timers[pane] !== undefined;
    }

    show(pane: ScrollPane): void {
        this.hide(pane);
        this.timers[pane] = setTimeout(() => {
            delete this.timers[pane];
            this.onHidden();
        }, HIDE_DELAY_MS);
    }

    hide(pane: ScrollPane): void {
        clearTimeout(this.timers[pane]);
        delete this.timers[pane];
    }

    dispose(): void {
        this.hide("jobs");
        this.hide("output");
    }
}

export interface ScrollThumb {
    top: number;
    size: number;
}

/** Thumb of a bar over `height` rows showing `total` rows from `start`; undefined when all fit. */
export function scrollThumb(start: number, height: number, total: number): ScrollThumb | undefined {
    if (height <= 0 || total <= height) {
        return undefined;
    }

    const size = Math.max(Math.min(2, height), Math.round((height * height) / total));

    return { top: Math.round((start / (total - height)) * (height - size)), size };
}

/**
 * Draws the bar over the last column of each row.
 *
 * Both panes reserve a padding column there, so revealing the bar never reflows or covers text.
 */
export function paintScrollbar(
    theme: Theme,
    rows: string[],
    thumb: ScrollThumb | undefined,
): string[] {
    if (!thumb) {
        return rows;
    }

    return rows.map((line, row) => {
        const onThumb = row >= thumb.top && row < thumb.top + thumb.size;

        return (
            line.slice(0, -1) +
            theme.fg(onThumb ? "scrollbarThumb" : "scrollbarTrack", onThumb ? "┃" : "│")
        );
    });
}
