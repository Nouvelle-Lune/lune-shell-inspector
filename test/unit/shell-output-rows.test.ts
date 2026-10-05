/**
 * Unit tests for the inspector's output rows: `OutputRowsCache` (what is re-read from the screen
 * and when), `WrappedOutput` (lazy tail versus full wrap) and `OutputViewport` (which rows a pane
 * shows and how scrolling pauses and resumes following).
 *
 * The pane has to stay cheap per keypress, so the contract is about work as much as about rows:
 * a cache hit must not read the screen again, and the cheap tail must show exactly what the
 * expensive full wrap would have ended with.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { OutputRowsCache, type ScreenSource } from "../../src/shell/inspector/output-rows.ts";
import { OutputViewport } from "../../src/shell/inspector/output-viewport.ts";

/** A screen source whose reads are counted, so tests can assert on how often it is touched. */
class FakeScreens implements ScreenSource {
    reads = 0;
    private readonly screens = new Map<string, { revision: number; lines: string[] }>();
    private nextRevision = 1;

    set(id: string, lines: string[]): void {
        this.screens.set(id, { revision: this.nextRevision++, lines });
    }

    getScreenRevision(id: string): number {
        return this.screens.get(id)!.revision;
    }

    getScreenLines(id: string): string[] {
        this.reads += 1;

        return [...this.screens.get(id)!.lines];
    }
}

const MIXED_LINES = [
    "short",
    "",
    "x".repeat(95),
    "编译完成".repeat(12),
    "\x1b[31mred " + "word ".repeat(30) + "\x1b[0m",
    "   ",
    "tail line",
];

function fullWrap(lines: string[], width: number): string[] {
    return lines.flatMap((line) => wrapTextWithAnsi(line, width));
}

describe("output rows cache", () => {
    it("serves repeated requests from one read of the screen", () => {
        const screens = new FakeScreens();
        screens.set("a", MIXED_LINES);
        const cache = new OutputRowsCache();

        const first = cache.get(screens, "a", 40);
        const second = cache.get(screens, "a", 40);

        assert.equal(screens.reads, 1);
        assert.equal(second, first);
    });

    it("reads again when the screen revision changes", () => {
        const screens = new FakeScreens();
        screens.set("a", ["one"]);
        const cache = new OutputRowsCache();
        cache.get(screens, "a", 40);

        screens.set("a", ["one", "two"]);
        const output = cache.get(screens, "a", 40);

        assert.equal(screens.reads, 2);
        assert.deepEqual(output.tail(10), ["one", "two"]);
    });

    it("re-wraps for a new width without trusting rows wrapped for the old one", () => {
        const screens = new FakeScreens();
        screens.set("a", ["x".repeat(60)]);
        const cache = new OutputRowsCache();

        assert.equal(cache.get(screens, "a", 60).totalRows, 1);
        assert.equal(cache.get(screens, "a", 20).totalRows, 3);
        assert.equal(cache.get(screens, "a", 60).totalRows, 1);
    });

    it("does not hand one job's rows to another", () => {
        const screens = new FakeScreens();
        screens.set("a", ["from a"]);
        screens.set("b", ["from b"]);
        const cache = new OutputRowsCache();

        cache.get(screens, "a", 40);

        assert.deepEqual(cache.get(screens, "b", 40).tail(5), ["from b"]);
    });

    it("reads again after being cleared", () => {
        const screens = new FakeScreens();
        screens.set("a", ["one"]);
        const cache = new OutputRowsCache();
        cache.get(screens, "a", 40);

        cache.clear();
        cache.get(screens, "a", 40);

        assert.equal(screens.reads, 2);
    });
});

describe("wrapped output", () => {
    for (const width of [1, 5, 17, 40, 200]) {
        it(`shows the same tail as the full wrap at width ${width}`, () => {
            const screens = new FakeScreens();
            screens.set("a", MIXED_LINES);
            const expected = fullWrap(MIXED_LINES, width);

            for (const count of [1, 2, 7, expected.length, expected.length + 5]) {
                // A fresh cache per count: the tail must not depend on a full wrap having happened.
                const output = new OutputRowsCache().get(screens, "a", width);

                assert.deepEqual(output.tail(count), expected.slice(-count), `tail(${count})`);
            }
        });
    }

    it("agrees with itself before and after the full wrap", () => {
        const screens = new FakeScreens();
        screens.set("a", MIXED_LINES);
        const output = new OutputRowsCache().get(screens, "a", 17);
        const lazy = output.tail(9);

        assert.equal(output.totalRows, fullWrap(MIXED_LINES, 17).length);
        assert.deepEqual(output.tail(9), lazy);
        assert.deepEqual(output.slice(0, output.totalRows), fullWrap(MIXED_LINES, 17));
    });

    it("counts logical lines apart from wrapped rows", () => {
        const screens = new FakeScreens();
        screens.set("a", ["x".repeat(100), ""]);
        const output = new OutputRowsCache().get(screens, "a", 10);

        assert.equal(output.lineCount, 2);
        assert.equal(output.totalRows, 11);
    });

    it("has no rows for an empty screen and none for a non-positive tail", () => {
        const screens = new FakeScreens();
        screens.set("a", []);
        const output = new OutputRowsCache().get(screens, "a", 10);

        assert.equal(output.lineCount, 0);
        assert.deepEqual(output.tail(5), []);
        assert.deepEqual(output.tail(0), []);
    });
});

describe("output viewport", () => {
    /** `count` one-row lines, so rows and lines coincide. */
    function outputOf(count: number) {
        const screens = new FakeScreens();
        screens.set("a", Array.from({ length: count }, (_, index) => `row ${index}`));

        return new OutputRowsCache().get(screens, "a", 40);
    }

    it("follows the newest rows by default", () => {
        const viewport = new OutputViewport();
        const view = viewport.view(outputOf(20), 5, false);

        assert.deepEqual(view.rows, ["row 15", "row 16", "row 17", "row 18", "row 19"]);
        assert.equal(view.newestHidden, 0);
        assert.equal(viewport.paused, false);
    });

    it("measures the position only when asked, and then agrees with the cheap view", () => {
        const viewport = new OutputViewport();
        const output = outputOf(20);
        const cheap = viewport.view(output, 5, false);
        const measured = viewport.view(output, 5, true);

        assert.equal(cheap.position, undefined);
        assert.deepEqual(measured.position, { start: 15, total: 20 });
        assert.deepEqual(measured.rows, cheap.rows);
    });

    it("pauses on the first step up and counts the rows it hides", () => {
        const viewport = new OutputViewport();
        const output = outputOf(20);
        viewport.view(output, 5, false);

        assert.equal(viewport.scrollBy(-2, () => output), "moved");

        const view = viewport.view(output, 5, false);

        assert.equal(viewport.paused, true);
        assert.deepEqual(view.rows[0], "row 13");
        assert.equal(view.newestHidden, 2);
    });

    it("ignores a downward step while following, without fetching the output", () => {
        const viewport = new OutputViewport();
        const output = outputOf(20);
        viewport.view(output, 5, false);
        let fetched = false;

        const result = viewport.scrollBy(1, () => {
            fetched = true;

            return output;
        });

        assert.equal(result, "ignored");
        assert.equal(fetched, false);
    });

    it("ignores scrolling before any frame was laid out", () => {
        const viewport = new OutputViewport();

        assert.equal(viewport.scrollBy(-1, () => outputOf(20)), "ignored");
        assert.equal(viewport.paused, false);
    });

    it("follows again once a downward step reaches the newest row", () => {
        const viewport = new OutputViewport();
        const output = outputOf(20);
        viewport.view(output, 5, false);
        viewport.scrollBy(-1, () => output);

        assert.equal(viewport.scrollBy(1, () => output), "moved");
        assert.equal(viewport.paused, false);
    });

    it("reports a step that cannot move as unchanged", () => {
        const viewport = new OutputViewport();
        const output = outputOf(20);
        viewport.view(output, 5, false);
        viewport.jumpToOldest();

        assert.equal(viewport.scrollBy(-1, () => output), "unchanged");
        assert.equal(viewport.paused, true);
    });

    it("keeps the rows it is reading while new output streams in", () => {
        const viewport = new OutputViewport();
        const output = outputOf(20);
        viewport.view(output, 5, false);
        viewport.scrollBy(-3, () => output);
        const before = viewport.view(output, 5, false).rows;

        const after = viewport.view(outputOf(30), 5, false);

        assert.deepEqual(after.rows, before);
        assert.equal(after.newestHidden, 13);
    });

    it("clamps a stale anchor when the output shrinks, then follows", () => {
        const viewport = new OutputViewport();
        viewport.view(outputOf(40), 5, false);
        viewport.jumpToOldest();
        viewport.scrollBy(10, () => outputOf(40));

        const view = viewport.view(outputOf(8), 5, true);

        assert.deepEqual(view.position, { start: 3, total: 8 });
        assert.equal(viewport.paused, false);
    });

    it("reports whether jumping to the oldest row or following changed anything", () => {
        const viewport = new OutputViewport();

        assert.equal(viewport.follow(), false);
        assert.equal(viewport.jumpToOldest(), true);
        assert.equal(viewport.jumpToOldest(), false);
        assert.equal(viewport.follow(), true);
        assert.equal(viewport.paused, false);
    });

    it("forgets the frame on reset", () => {
        const viewport = new OutputViewport();
        const output = outputOf(20);
        viewport.view(output, 5, false);
        viewport.jumpToOldest();

        viewport.reset();

        assert.equal(viewport.paused, false);
        assert.equal(viewport.scrollBy(-1, () => output), "ignored");
    });
});
