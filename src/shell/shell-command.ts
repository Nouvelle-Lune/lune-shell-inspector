import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Keep command previews on one terminal row before applying a column budget. */
export function formatShellCommand(command: string, maxWidth: number): string {
    const singleLine = stripTerminalSequences(command)
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();

    if (visibleWidth(singleLine) <= maxWidth) {
        return singleLine;
    }

    return truncateToWidth(singleLine, maxWidth, "…");
}
