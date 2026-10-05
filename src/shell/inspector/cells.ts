import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** One padding column on each side keeps text off the pane borders and leaves room for a scrollbar. */
export function cell(text: string, width: number): string {
    return ` ${truncateToWidth(text, Math.max(0, width - 2), "…", true)} `;
}

export function pad(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Exactly `height` rows: shorter content is padded with blanks, longer content is cut. */
export function fill(rows: readonly string[], width: number, height: number): string[] {
    const filled = rows.slice(0, height);

    while (filled.length < height) {
        filled.push(" ".repeat(width));
    }

    return filled;
}
