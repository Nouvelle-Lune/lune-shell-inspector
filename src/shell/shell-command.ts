import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Collapse a command onto one terminal row before applying a column budget. */
export function collapseShellCommand(command: string): string {
    return stripTerminalSequences(command)
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}

/** Keep command previews on one terminal row before applying a column budget. */
export function formatShellCommand(command: string, maxWidth: number): string {
    return fitShellCommand(collapseShellCommand(command), maxWidth);
}

/** Applies a column budget to a command that `collapseShellCommand` already normalized. */
export function fitShellCommand(singleLine: string, maxWidth: number): string {
    if (visibleWidth(singleLine) <= maxWidth) {
        return singleLine;
    }

    return truncateToWidth(singleLine, maxWidth, "…");
}
