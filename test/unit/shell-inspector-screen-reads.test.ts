/**
 * Unit tests for how much of the screen the shell inspector re-reads while the user scrolls.
 *
 * A job's screen holds up to a few thousand rows, and reading and wrapping all of them for every
 * wheel tick or repaint is what made the overlay lag. The tests count reads of the screen (not
 * elapsed time, which would be flaky) and pin the other half of the contract: a repaint that skips
 * the read must still show what is currently on the screen - new output, redrawn lines, another
 * job under a reused id, and a different pane width.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";

import { ShellInspector } from "../../src/shell/shell-inspector.ts";
import { shellManager } from "../../src/shell/shell-manager.ts";
import { readJobScreen } from "../harness.ts";

const SHIFT_UP = "\x1b[1;2A";
const END = "\x1b[F";
const WIDTH = 110;
const TERMINAL_ROWS = 40;

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

async function addJob(id: string, output: string): Promise<void> {
    shellManager.startJob({ id, command: `cmd ${id}`, cwd: "/work", controller: new AbortController() });
    await write(id, output);
}

/** Reads of the screen made by the test's own flush are not the inspector's, so they are not counted. */
let screenReads = 0;

async function write(id: string, output: string): Promise<void> {
    shellManager.appendOutput(id, output);

    const readsBefore = screenReads;
    await readJobScreen(id);
    screenReads = readsBefore;
}

function lines(prefix: string, count: number): string {
    return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\r\n`).join("");
}

/** Right-pane text of every rendered line, without the frame. */
function paneText(frame: string[]): string {
    return frame.join("\n");
}

describe("shell inspector screen reads", () => {
    let inspector: ShellInspector;
    let restoreRead: () => void;

    beforeEach(() => {
        shellManager.clearAllJobs();
        screenReads = 0;

        const original = shellManager.getScreenLines.bind(shellManager);
        shellManager.getScreenLines = (id: string) => {
            screenReads += 1;

            return original(id);
        };
        restoreRead = () => {
            // The instance property shadows the prototype method; deleting it restores the original.
            delete (shellManager as { getScreenLines?: unknown }).getScreenLines;
        };

        inspector = new ShellInspector(
            { ui: { theme } } as unknown as ExtensionContext,
            () => {},
            () => {},
            () => TERMINAL_ROWS,
            theme,
        );
    });

    afterEach(() => {
        inspector.dispose();
        restoreRead();
        shellManager.clearAllJobs();
    });

    function wheel(x: number, y: number, wheelDelta: number): void {
        const event: TuiMouseEvent = {
            type: "wheel",
            button: "none",
            x,
            y,
            screenX: x,
            screenY: y,
            width: WIDTH,
            height: 30,
            shift: false,
            alt: false,
            ctrl: false,
            wheelDelta,
        };

        inspector.handleMouse(event);
    }

    it("reads the screen once for a run of repaints and scroll steps", async () => {
        await addJob("a", lines("line", 500));
        inspector.render(WIDTH);
        screenReads = 0;

        for (let step = 0; step < 20; step++) {
            inspector.handleInput(SHIFT_UP);
            inspector.render(WIDTH);
        }
        inspector.handleInput(END);
        inspector.render(WIDTH);

        assert.ok(screenReads <= 1, `expected at most one screen read, got ${screenReads}`);
    });

    it("reads the screen once for a burst of wheel ticks followed by a repaint", async () => {
        await addJob("a", lines("line", 500));
        inspector.render(WIDTH);
        screenReads = 0;

        for (let tick = 0; tick < 30; tick++) {
            wheel(90, 10, -1);
        }
        inspector.render(WIDTH);

        assert.ok(screenReads <= 1, `expected at most one screen read, got ${screenReads}`);
    });

    it("does not re-read the selected screen when another job writes", async () => {
        await addJob("a", lines("a", 50));
        await addJob("b", lines("b", 50));
        inspector.render(WIDTH);
        screenReads = 0;

        await write("b", lines("more", 5));
        inspector.render(WIDTH);

        assert.equal(screenReads, 0, "output of an unselected job must not cost a read");
    });

    it("shows output that arrived after the last repaint", async () => {
        await addJob("a", lines("old", 30));
        inspector.render(WIDTH);

        await write("a", lines("fresh", 3));
        const frame = paneText(inspector.render(WIDTH));

        assert.match(frame, /fresh 3/);
    });

    it("shows a line the program redrew in place", async () => {
        await addJob("a", "progress 10%\r");
        assert.match(paneText(inspector.render(WIDTH)), /progress 10%/);

        await write("a", "progress 90%\r");
        const frame = paneText(inspector.render(WIDTH));

        assert.match(frame, /progress 90%/);
        assert.doesNotMatch(frame, /progress 10%/);
    });

    it("shows the new job's output when a cleared job's id is reused", async () => {
        await addJob("a", lines("old", 30));
        inspector.render(WIDTH);
        shellManager.settleJob("a", { type: "completed", exitCode: 0 });
        inspector.handleInput("c");

        await addJob("a", lines("new", 30));
        const frame = paneText(inspector.render(WIDTH));

        assert.match(frame, /new 30/);
        assert.doesNotMatch(frame, /old \d/);
    });

    it("re-wraps the same output when the pane width changes", async () => {
        const sentence = "w".repeat(150);
        await addJob("a", `${sentence}\r\n`);

        const wide = inspector.render(200);
        const narrow = inspector.render(WIDTH);
        const longestRun = (frame: string[]) =>
            Math.max(...frame.map((line) => (line.match(/w+/g) ?? [""]).reduce((max, run) => Math.max(max, run.length), 0)));

        assert.equal(longestRun(wide), 150);
        assert.ok(longestRun(narrow) < 150, "the narrow frame must wrap the line");
    });

    it("keeps showing the rows being read while a paused job streams", async () => {
        await addJob("a", lines("line", 200));
        inspector.render(WIDTH);
        for (let step = 0; step < 5; step++) {
            inspector.handleInput(SHIFT_UP);
            inspector.render(WIDTH);
        }
        const before = paneText(inspector.render(WIDTH));

        await write("a", lines("streamed", 25));
        const after = paneText(inspector.render(WIDTH));

        assert.doesNotMatch(after, /streamed/);
        assert.match(after, /paused/);
        assert.equal(
            before.match(/line \d+/g)?.at(-1),
            after.match(/line \d+/g)?.at(-1),
            "the newest visible row must not move while paused",
        );
    });

    it("shows the oldest rows after scrollback was trimmed", async () => {
        // Past the emulator's scrollback the oldest lines are gone; Home must land on what remains.
        await addJob("a", lines("row", 6000));
        inspector.render(WIDTH);

        inspector.handleInput("\x1b[H");
        const frame = paneText(inspector.render(WIDTH));
        const oldest = Number(frame.match(/row (\d+)/)![1]);

        assert.ok(oldest > 1, `the first rows were trimmed from the screen, got row ${oldest}`);
        assert.match(frame, /paused/);
    });
});
