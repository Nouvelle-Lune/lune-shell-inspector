/** The part of an xterm terminal the feed drives; a test double only has to implement this. */
export interface ScreenSink {
    write(data: string, callback?: () => void): void;
}

// xterm throws from write() once more than 50M characters wait behind its parser, which a pipe
// outruns easily (`yes`, a build log). Both limits sit far below that, and together they bound the
// memory a flooding job can pin.
const QUEUED_LIMIT = 4_000_000;
const HELD_LIMIT = 4_000_000;

// Held chunks are merged up to this size so a producer of tiny writes cannot build a huge array.
const MERGE_BELOW = 64 * 1024;

/**
 * Hands output to a job's emulator without ever letting its parser queue grow past xterm's limit.
 *
 * The screen only shows the last few thousand rows, so when output arrives faster than it is
 * parsed the oldest unparsed output is dropped and the newest is kept: the stream's end is what
 * the screen has to show. Nothing else depends on this path - the retained text and the spill file
 * are written before it - so dropped output is still available in full there.
 */
export class ScreenFeed {
    private readonly sink: ScreenSink;
    private queued = 0;
    private held: string[] = [];
    private heldChars = 0;
    private disposed = false;

    constructor(sink: ScreenSink) {
        this.sink = sink;
    }

    write(chunk: string): void {
        if (this.disposed || chunk === "") {
            return;
        }

        // Order matters: once anything is held, a newer chunk must not overtake it.
        if (this.held.length === 0 && this.fitsQueue(chunk.length)) {
            this.send(chunk);
            return;
        }

        this.hold(chunk);
    }

    dispose(): void {
        // Pending callbacks may never run once the terminal is gone, so nothing can be drained later.
        this.disposed = true;
        this.held = [];
        this.heldChars = 0;
    }

    // A chunk is always accepted by an empty queue, whatever its size, so held output cannot stall.
    private fitsQueue(size: number): boolean {
        return this.queued === 0 || this.queued + size <= QUEUED_LIMIT;
    }

    private send(chunk: string): void {
        this.queued += chunk.length;

        this.sink.write(chunk, () => {
            this.queued -= chunk.length;
            this.drain();
        });
    }

    private hold(chunk: string): void {
        const newest = chunk.length > HELD_LIMIT ? chunk.slice(-HELD_LIMIT) : chunk;
        const last = this.held.length - 1;

        if (last >= 0 && this.held[last]!.length < MERGE_BELOW) {
            this.held[last] += newest;
        } else {
            this.held.push(newest);
        }

        this.heldChars += newest.length;

        while (this.heldChars > HELD_LIMIT && this.held.length > 1) {
            this.heldChars -= this.held.shift()!.length;
        }
    }

    private drain(): void {
        while (!this.disposed && this.held.length > 0 && this.fitsQueue(this.held[0]!.length)) {
            const chunk = this.held.shift()!;

            this.heldChars -= chunk.length;
            this.send(chunk);
        }
    }
}
