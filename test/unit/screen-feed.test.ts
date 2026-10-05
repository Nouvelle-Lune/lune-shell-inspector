/**
 * Unit tests for `ScreenFeed`, the flow control between a job's output and its emulator.
 *
 * xterm throws once its parse queue passes 50M characters, which a pipe outruns, and an exception
 * from the stream handler takes the whole host down. The contract: writing never throws however
 * fast output arrives, the emulator's queue stays bounded, and when output has to be dropped it is
 * the oldest unparsed output, in order, so the screen still ends with the newest.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ScreenFeed, type ScreenSink } from "../../src/shell/screen-feed.ts";
import { shellManager } from "../../src/shell/shell-manager.ts";
import { readJobScreen } from "../harness.ts";

/** The emulator's queue as xterm models it: it throws past the limit and parses only on demand. */
class FakeEmulator implements ScreenSink {
    static readonly LIMIT = 50_000_000;

    readonly parsed: string[] = [];
    peakQueued = 0;

    private queue: { data: string; callback?: () => void }[] = [];
    private queuedChars = 0;

    write(data: string, callback?: () => void): void {
        if (this.queuedChars > FakeEmulator.LIMIT) {
            throw new Error("write data discarded, use flow control to avoid losing data");
        }

        this.queue.push({ data, callback });
        this.queuedChars += data.length;
        this.peakQueued = Math.max(this.peakQueued, this.queuedChars);
    }

    /** Parses everything queued so far, running callbacks the way xterm does after each chunk. */
    parseAll(): void {
        while (this.queue.length > 0) {
            const { data, callback } = this.queue.shift()!;

            this.queuedChars -= data.length;
            this.parsed.push(data);
            callback?.();
        }
    }

    get text(): string {
        return this.parsed.join("");
    }
}

const MB = 1024 * 1024;

function flood(feed: ScreenFeed, totalChars: number, chunkSize: number): string {
    let last = "";

    for (let written = 0; written < totalChars; written += chunkSize) {
        last = `${String(written / chunkSize).padStart(8, "0")}|`.padEnd(chunkSize - 1, "x") + "\n";
        feed.write(last);
    }

    return last;
}

describe("screen feed", () => {
    it("passes output through unchanged while the emulator keeps up", () => {
        const emulator = new FakeEmulator();
        const feed = new ScreenFeed(emulator);

        feed.write("one\n");
        feed.write("two\n");
        emulator.parseAll();
        feed.write("three\n");
        emulator.parseAll();

        assert.equal(emulator.text, "one\ntwo\nthree\n");
    });

    it("does not throw when output outruns the emulator by far more than its limit", () => {
        const emulator = new FakeEmulator();
        const feed = new ScreenFeed(emulator);

        assert.doesNotThrow(() => flood(feed, 400 * MB, 64 * 1024));
    });

    it("keeps the emulator's queue far below its limit", () => {
        const emulator = new FakeEmulator();
        const feed = new ScreenFeed(emulator);

        flood(feed, 400 * MB, 64 * 1024);

        assert.ok(
            emulator.peakQueued < FakeEmulator.LIMIT / 4,
            `queue peaked at ${emulator.peakQueued} characters`,
        );
    });

    it("ends with the newest output, in order, after dropping the oldest", () => {
        const emulator = new FakeEmulator();
        const feed = new ScreenFeed(emulator);

        const newest = flood(feed, 200 * MB, 64 * 1024);
        emulator.parseAll();
        emulator.parseAll();

        const text = emulator.text;
        const rows = text.split("\n").filter((row) => row !== "");
        const numbers = rows.map((row) => Number(row.slice(0, 8)));

        assert.ok(text.endsWith(newest), "the newest chunk must be the last thing the emulator saw");
        assert.ok(text.length < 200 * MB, "the flood must have been shortened");
        assert.deepEqual(
            numbers,
            [...numbers].sort((a, b) => a - b),
            "chunks must reach the emulator in the order they were written",
        );
    });

    it("never lets a chunk written later overtake one that is held back", () => {
        const emulator = new FakeEmulator();
        const feed = new ScreenFeed(emulator);

        feed.write("a".repeat(5_000_000));
        feed.write("b\n");
        feed.write("c\n");
        emulator.parseAll();
        emulator.parseAll();

        assert.ok(emulator.text.endsWith("b\nc\n"));
    });

    it("accepts one chunk larger than every limit rather than stalling on it", () => {
        const emulator = new FakeEmulator();
        const feed = new ScreenFeed(emulator);

        feed.write("head\n");
        feed.write("y".repeat(30 * MB) + "tail\n");
        emulator.parseAll();
        emulator.parseAll();

        assert.ok(emulator.text.endsWith("tail\n"));
    });

    it("merges tiny writes instead of holding one entry per write", () => {
        const emulator = new FakeEmulator();
        const feed = new ScreenFeed(emulator);

        feed.write("z".repeat(5_000_000));

        for (let i = 0; i < 200_000; i++) {
            feed.write(`tiny-${i}\n`);
        }

        emulator.parseAll();
        emulator.parseAll();

        assert.ok(emulator.text.endsWith("tiny-199999\n"));
    });

    it("writes nothing once disposed, and does not throw", () => {
        const emulator = new FakeEmulator();
        const feed = new ScreenFeed(emulator);

        feed.write("a".repeat(5_000_000));
        feed.write("held\n");
        feed.dispose();
        emulator.parseAll();
        feed.write("after\n");
        emulator.parseAll();

        assert.equal(emulator.text.includes("after"), false);
        assert.equal(emulator.text.includes("held"), false);
    });
});

describe("shell manager under an output flood", () => {
    it("survives output that arrives faster than the emulator parses it", async () => {
        shellManager.startJob({
            id: "flood",
            command: "yes",
            cwd: "/work",
            controller: new AbortController(),
        });

        try {
            const line = "y".repeat(99) + "\n";
            const chunk = line.repeat(1024);

            assert.doesNotThrow(() => {
                for (let sent = 0; sent < 120 * MB; sent += chunk.length) {
                    shellManager.appendOutput("flood", chunk);
                }

                shellManager.appendOutput("flood", "the end\n");
            });

            const deadline = Date.now() + 30_000;
            let screen = await readJobScreen("flood");

            while (screen.at(-1) !== "the end" && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                screen = await readJobScreen("flood");
            }

            assert.equal(screen.at(-1), "the end", "the screen must end with the newest output");
        } finally {
            shellManager.clearAllJobs();
        }
    });
});
