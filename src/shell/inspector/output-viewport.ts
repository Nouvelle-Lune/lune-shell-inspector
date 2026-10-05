import type { WrappedOutput } from "./output-rows.ts";

export interface OutputView {
    rows: string[];
    /** Rows below the view that the user has not seen yet. */
    newestHidden: number;
    /** Where `rows` sit in the whole output; only measured when the caller asked for it. */
    position?: { start: number; total: number };
}

export type ScrollResult = "ignored" | "moved" | "unchanged";

/**
 * Which wrapped output rows the details pane shows.
 *
 * The position is an absolute anchor (the first visible row), not an offset from the tail, and
 * `undefined` follows the newest output. That is what makes scrolling a pause: with a tail-relative
 * offset, streamed lines would drag the viewport along while the user reads.
 */
export class OutputViewport {
    private anchor: number | undefined;
    /** Rows the last frame could show; key handling needs it to clamp the anchor. */
    private capacity = 0;

    get paused(): boolean {
        return this.anchor !== undefined;
    }

    /**
     * Fits the viewport to a frame. The clamped anchor is stored back so the position stays valid
     * when the output shrinks or the pane is resized, and landing on the newest row means following.
     *
     * A following view needs nothing but the last rows, so the total is only measured when the view
     * is paused or the caller needs the position to draw a scrollbar.
     */
    view(output: WrappedOutput, capacity: number, withPosition: boolean): OutputView {
        this.capacity = capacity;

        if (this.anchor === undefined && !withPosition) {
            return { rows: output.tail(capacity), newestHidden: 0 };
        }

        const total = output.totalRows;
        const tailStart = Math.max(0, total - capacity);
        const start = this.anchor === undefined ? tailStart : Math.min(this.anchor, tailStart);

        this.anchor = start >= tailStart ? undefined : start;

        return {
            rows: output.slice(start, start + Math.min(capacity, total - start)),
            newestHidden: Math.max(0, total - (start + capacity)),
            position: { start, total },
        };
    }

    /**
     * Moves by `step` rows, pausing from the tail and following again once the tail is in view.
     *
     * The output is a getter because a scroll that changes nothing is decided without it, and
     * fetching it can mean re-reading the screen.
     */
    scrollBy(step: number, getOutput: () => WrappedOutput): ScrollResult {
        if (this.capacity === 0 || (this.anchor === undefined && step > 0)) {
            return "ignored";
        }

        const tailStart = Math.max(0, getOutput().totalRows - this.capacity);
        const previousStart = this.anchor ?? tailStart;

        this.anchor = Math.min(tailStart, Math.max(0, previousStart + step));

        if (this.anchor >= tailStart) {
            this.anchor = undefined;
        }

        return (this.anchor ?? tailStart) !== previousStart ? "moved" : "unchanged";
    }

    /** Returns whether the view was anywhere but the oldest row. */
    jumpToOldest(): boolean {
        const moved = this.anchor !== 0;
        this.anchor = 0;

        return moved;
    }

    /** Returns whether the view was paused. */
    follow(): boolean {
        const wasPaused = this.anchor !== undefined;
        this.anchor = undefined;

        return wasPaused;
    }

    /** Forgets the frame too, for when there is no output to show. */
    reset(): void {
        this.anchor = undefined;
        this.capacity = 0;
    }
}
