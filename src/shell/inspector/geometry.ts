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

/** Top border, header and the separator above the panes. */
export const BODY_TOP = 3;

export interface PaneGeometry {
    bodyHeight: number;
    /** Columns between the outer borders. */
    innerWidth: number;
    leftWidth: number;
    rightWidth: number;
    /** First column of the right pane in overlay-local cells; mouse events are hit-tested against it. */
    rightStart: number;
}

export function paneGeometry(width: number, terminalRows: number): PaneGeometry {
    const bodyHeight = Math.min(
        BODY_MAX_HEIGHT,
        Math.max(
            BODY_MIN_HEIGHT,
            Math.floor(terminalRows * OVERLAY_HEIGHT_RATIO) - FRAME_HEIGHT,
        ),
    );

    const innerWidth = Math.max(
        LEFT_PANE_MIN_WIDTH + RIGHT_PANE_MIN_WIDTH + 1,
        width - 2, // One column for each frame border: │ content │
    );

    const leftWidth = Math.min(
        LEFT_PANE_MAX_WIDTH,
        Math.max(LEFT_PANE_MIN_WIDTH, Math.round(innerWidth * LEFT_PANE_RATIO)),
        innerWidth - RIGHT_PANE_MIN_WIDTH - 1,
    );

    // One column for the separator: │ left │ right │
    const rightWidth = innerWidth - leftWidth - 1;

    // Columns: │ left │ right │
    return { bodyHeight, innerWidth, leftWidth, rightWidth, rightStart: leftWidth + 2 };
}

/** First listed job, keeping the selection centred until the list runs out on either side. */
export function listWindowStart(
    selectedIndex: number,
    jobCount: number,
    bodyHeight: number,
): number {
    return Math.min(
        Math.max(0, selectedIndex - Math.floor(bodyHeight / 2)),
        Math.max(0, jobCount - bodyHeight),
    );
}
