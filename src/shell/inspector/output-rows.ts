import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface ScreenSource {
    getScreenRevision(id: string): number;
    getScreenLines(id: string): string[];
}

// A job's screen is capped by the emulator's scrollback at roughly 250K characters, so one
// generation holds a few full screens.
const GENERATION_LIMIT_CHARS = 1_000_000;

/**
 * Wrapped rows per logical line.
 *
 * A streaming job changes a few lines per frame and a full scrollback shifts every line by one, so
 * keying by text keeps wrapping to the lines that are actually new. Two generations bound the
 * memory: lines the last frames did not need are dropped on the next rotation.
 */
class LineWrapCache {
    private width = 0;
    private recent = new Map<string, readonly string[]>();
    private previous = new Map<string, readonly string[]>();
    private recentChars = 0;

    rows(line: string, width: number): readonly string[] {
        if (width !== this.width) {
            this.clear();
            this.width = width;
        }

        const hit = this.recent.get(line);

        if (hit) {
            return hit;
        }

        const rows = this.previous.get(line) ?? wrapTextWithAnsi(line, width);

        if (this.recentChars >= GENERATION_LIMIT_CHARS) {
            this.previous = this.recent;
            this.recent = new Map();
            this.recentChars = 0;
        }

        this.recent.set(line, rows);
        this.recentChars += line.length;

        return rows;
    }

    clear(): void {
        this.recent.clear();
        this.previous.clear();
        this.recentChars = 0;
    }
}

/**
 * A screen wrapped to a pane width, as the visual rows the output pane scrolls through.
 *
 * Wrapping the whole scrollback is what costs time, and a pane that follows the newest output only
 * needs its last rows, so the full list is built the first time something asks for a total or a
 * slice and the tail is wrapped from the end without it.
 */
export class WrappedOutput {
    /** Logical lines of the screen; the output header counts these, not the wrapped rows. */
    readonly lineCount: number;

    private readonly lines: readonly string[];
    private readonly width: number;
    private readonly wraps: LineWrapCache;
    private all: string[] | undefined;

    constructor(lines: readonly string[], width: number, wraps: LineWrapCache) {
        this.lines = lines;
        this.lineCount = lines.length;
        this.width = width;
        this.wraps = wraps;
    }

    get totalRows(): number {
        return this.allRows().length;
    }

    slice(start: number, end: number): string[] {
        return this.allRows().slice(start, end);
    }

    tail(count: number): string[] {
        if (count <= 0) {
            return [];
        }

        if (this.all) {
            return this.all.slice(-count);
        }

        const chunks: (readonly string[])[] = [];
        let rows = 0;

        for (let index = this.lines.length - 1; index >= 0 && rows < count; index--) {
            const wrapped = this.wraps.rows(this.lines[index]!, this.width);

            chunks.push(wrapped);
            rows += wrapped.length;
        }

        return chunks.reverse().flat().slice(-count);
    }

    private allRows(): string[] {
        this.all ??= this.lines.flatMap((line) => this.wraps.rows(line, this.width));

        return this.all;
    }
}

/**
 * The selected job's output, rebuilt only when its screen or the width changed.
 *
 * Scrolling and repainting a frame must cost a slice of the rows, not a re-read and re-wrap of the
 * whole scrollback: reading the screen and wrapping it both scale with the output size.
 */
export class OutputRowsCache {
    private readonly wraps = new LineWrapCache();
    private entry: { jobId: string; revision: number; width: number; output: WrappedOutput } | undefined;

    get(source: ScreenSource, jobId: string, width: number): WrappedOutput {
        const revision = source.getScreenRevision(jobId);
        const entry = this.entry;

        if (
            entry &&
            entry.jobId === jobId &&
            entry.revision === revision &&
            entry.width === width
        ) {
            return entry.output;
        }

        const output = new WrappedOutput(source.getScreenLines(jobId), width, this.wraps);

        this.entry = { jobId, revision, width, output };

        return output;
    }

    clear(): void {
        this.entry = undefined;
        this.wraps.clear();
    }
}
