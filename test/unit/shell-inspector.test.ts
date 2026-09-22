/**
 * Unit tests for the shell inspector's output scrolling.
 *
 * The inspector renders the selected job's output tail in a fixed pane, and the scroll keys shift
 * which lines that pane shows: Shift+Up/Shift+K one line older, Shift+Down/Shift+J one line newer,
 * Home to the oldest line, End back to the newest. Following the newest output is the default, and
 * it is what the pane returns to once the newest line is in view again - scrolling is a pause, not
 * a mode. Switching jobs always shows the newly selected job's newest output.
 *
 * The tests render the real component against the real `shellManager` singleton with a recording
 * stub theme, so assertions read plain strings (no ANSI) and the paused marker can be checked by
 * the color it asks for. The overlay, key routing and the real TUI are out of scope here;
 * `test/tui` observes those by hand.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import { ShellInspector } from "../../src/shell/shell-inspector.ts";
import { shellManager } from "../../src/shell/shell-manager.ts";

/** Raw sequences a terminal sends for the inspector's keys. */
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const HOME = "\x1b[H";
const END = "\x1b[F";

/** Panel width used by every test: wide enough for the right pane to keep long lines untruncated. */
const WIDTH = 110;

/** Rows of a terminal tall enough for the body to hit its maximum height. */
const TERMINAL_ROWS = 40;

interface StubTheme {
    theme: Theme;
    fgCalls: { color: string; text: string }[];
}

/** Theme stub: colors become plain text, and every `fg` call is recorded. */
function createStubTheme(): StubTheme {
    const fgCalls: { color: string; text: string }[] = [];

    const theme = {
        fg: (color: string, text: string) => {
            fgCalls.push({ color, text });
            return text;
        },
        bold: (text: string) => text,
    } as unknown as Theme;

    return { theme, fgCalls };
}

/** Output of `count` numbered lines, oldest first. */
function lineOutput(count: number): string {
    return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

/** Add a running job whose output is already complete for the purposes of rendering. */
function addJob(id: string, command: string, output: string): void {
    shellManager.startJob({ id, command, cwd: "/work" });
    shellManager.updateOutput(id, output);
}

/** The right pane of one rendered line; empty for the separator and border lines. */
function rightCell(line: string): string {
    const cells = line.split("│");
    return cells.length === 4 ? cells[2]!.trim() : "";
}

describe("shell inspector", () => {
    let stub: StubTheme;
    let inspector: ShellInspector;
    let renderRequests: number;

    beforeEach(() => {
        shellManager.clearAllJobs();
        stub = createStubTheme();
        renderRequests = 0;

        inspector = new ShellInspector(
            { ui: { theme: stub.theme } } as unknown as ExtensionContext,
            () => {
                renderRequests += 1;
            },
            () => { },
            () => TERMINAL_ROWS,
            stub.theme,
        );
    });

    afterEach(() => {
        shellManager.clearAllJobs();
        // dispose() also stops the refresh interval the running jobs started, so tests cannot leak
        // a timer into the next one.
        inspector.dispose();
    });

    /**
     * Press one key after a render.
     *
     * The TUI draws the overlay before it routes input to it, and the scroll keys clamp against the
     * geometry of the last frame, so a test that sends keys into a never-rendered inspector would
     * exercise a state the TUI cannot produce.
     */
    function press(data: string): void {
        inspector.render(WIDTH);
        inspector.handleInput(data);
    }

    /**
     * One rendered frame and the `fg` calls it made.
     *
     * The recording is reset per frame: a marker that only the previous frame drew must not look
     * like it is still on screen.
     */
    function frame(): { lines: string[]; fgCalls: { color: string; text: string }[] } {
        stub.fgCalls.length = 0;

        return { lines: inspector.render(WIDTH), fgCalls: [...stub.fgCalls] };
    }

    /** Output rows of the right pane, in render order. */
    function visibleOutput(): string[] {
        return frame()
            .lines
            .map(rightCell)
            .filter((cell) => cell.startsWith("├─ ") || cell.startsWith("└─ "))
            .map((cell) => cell.slice(3));
    }

    /** The paused marker of the newest frame, if its `Output` header drew one. */
    function pausedMarker(): string | undefined {
        return frame()
            .fgCalls
            .filter((call) => call.color === "warning")
            .at(-1)
            ?.text;
    }

    it("pins the output pane to the newest lines", () => {
        addJob("job-1", "tail -f app.log", lineOutput(40));

        const visible = visibleOutput();

        assert.ok(visible.length > 1, "the pane must show several output lines");
        assert.equal(visible.at(-1), "line 40");
        assert.ok(!visible.includes("line 1"), "the pane must not start at the oldest line");
        assert.equal(pausedMarker(), undefined);
    });

    it("shows the newest output of a short job without a pause marker", () => {
        addJob("job-1", "echo done", lineOutput(3));

        assert.deepEqual(visibleOutput(), ["line 1", "line 2", "line 3"]);
        assert.equal(pausedMarker(), undefined);
    });

    it("scrolls one line back with Shift+Up and pauses the newest output", () => {
        addJob("job-1", "tail -f app.log", lineOutput(40));
        const redrawsBefore = renderRequests;

        press(SHIFT_UP);

        const visible = visibleOutput();

        assert.equal(visible.at(-1), "line 39");
        assert.ok(!visible.includes("line 40"), "the newest line must leave the pane while paused");
        assert.equal(pausedMarker(), " · paused ↑1");
        assert.equal(renderRequests, redrawsBefore + 1, "scrolling must ask for a redraw");
    });

    it("scrolls one line back with Shift+K", () => {
        addJob("job-1", "tail -f app.log", lineOutput(40));

        press("K");

        assert.equal(visibleOutput().at(-1), "line 39");
    });

    it("scrolls one line forward with Shift+Down and leaves the pause", () => {
        addJob("job-1", "tail -f app.log", lineOutput(40));

        press(SHIFT_UP);
        press(SHIFT_UP);
        assert.equal(visibleOutput().at(-1), "line 38");

        press(SHIFT_DOWN);

        assert.equal(visibleOutput().at(-1), "line 39");
        assert.equal(pausedMarker(), " · paused ↑1");
    });

    it("resumes following once the newest line is in view again", () => {
        addJob("job-1", "tail -f app.log", lineOutput(40));

        press(SHIFT_UP);
        press("J");

        assert.equal(pausedMarker(), undefined);
        assert.equal(visibleOutput().at(-1), "line 40");

        shellManager.updateOutput("job-1", lineOutput(41));

        assert.equal(visibleOutput().at(-1), "line 41", "following means new output moves the pane");
    });

    it("keeps a paused pane anchored while new output streams in", () => {
        addJob("job-1", "tail -f app.log", lineOutput(40));

        press(SHIFT_UP);
        press(SHIFT_UP);
        const paused = visibleOutput();

        shellManager.updateOutput("job-1", lineOutput(41));

        assert.deepEqual(visibleOutput(), paused, "a paused pane must not drift with the tail");
        assert.equal(pausedMarker(), " · paused ↑3");
    });

    it("does not scroll past the oldest line", () => {
        addJob("job-1", "tail -f app.log", lineOutput(40));

        for (let i = 0; i < 100; i++) {
            press(SHIFT_UP);
        }

        assert.equal(visibleOutput().at(0), "line 1");
    });

    it("ignores scrolling on a job with nothing to scroll", () => {
        addJob("job-1", "echo done", lineOutput(3));

        press(SHIFT_UP);

        assert.deepEqual(visibleOutput(), ["line 1", "line 2", "line 3"]);
        assert.equal(pausedMarker(), undefined);
    });

    it("jumps to the oldest line with Home and back to the newest with End", () => {
        addJob("job-1", "tail -f app.log", lineOutput(40));

        press(HOME);

        assert.equal(visibleOutput().at(0), "line 1");
        assert.ok(pausedMarker()?.startsWith(" · paused ↑"));

        press(END);

        assert.equal(visibleOutput().at(-1), "line 40");
        assert.equal(pausedMarker(), undefined);
    });

    it("shows the newest output of the selected job after switching jobs", () => {
        addJob("job-a", "tail -f a.log", lineOutput(40));
        addJob("job-b", "echo b", lineOutput(3));

        press(SHIFT_UP);
        assert.equal(pausedMarker(), " · paused ↑1");

        press("j");

        assert.deepEqual(visibleOutput(), ["line 1", "line 2", "line 3"]);
        assert.equal(pausedMarker(), undefined);

        press("k");

        assert.equal(visibleOutput().at(-1), "line 40", "the previous job must reset to its newest output");
        assert.equal(pausedMarker(), undefined);
    });

    it("keeps plain j and k on job selection instead of scrolling", () => {
        addJob("job-a", "tail -f a.log", lineOutput(40));
        addJob("job-b", "echo b", lineOutput(3));

        press("j");

        assert.deepEqual(visibleOutput(), ["line 1", "line 2", "line 3"]);
    });
});
