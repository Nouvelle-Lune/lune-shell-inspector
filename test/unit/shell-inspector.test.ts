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
import { visibleWidth } from "@earendil-works/pi-tui";

import { ShellInspector } from "../../src/shell/shell-inspector.ts";
import { shellManager } from "../../src/shell/shell-manager.ts";
import { readJobScreen } from "../harness.ts";

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

/** Write a job's output and wait until the emulator has executed it. */
async function writeOutput(id: string, output: string): Promise<void> {
    shellManager.appendOutput(id, output);
    await readJobScreen(id);
}

/** Add a running job whose output is already complete for the purposes of rendering. */
async function addJob(id: string, command: string, output: string): Promise<void> {
    shellManager.startJob({ id, command, cwd: "/work", controller: new AbortController() });
    await writeOutput(id, output);
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

    /**
     * Output rows of the right pane, in render order.
     *
     * Output starts on the row after the `Output · …` header. The body pads the rest of the pane
     * with blank rows, so only trailing blanks are padding - a blank line inside the output itself
     * is real and must stay.
     */
    function visibleOutput(): string[] {
        const cells = frame().lines.map(rightCell);
        const headerIndex = cells.findIndex((cell) => cell.startsWith("Output ·"));

        if (headerIndex < 0) {
            return [];
        }

        const rows = cells.slice(headerIndex + 1);

        while (rows.at(-1) === "") {
            rows.pop();
        }

        return rows;
    }

    /** The paused marker of the newest frame, if its `Output` header drew one. */
    function pausedMarker(): string | undefined {
        return frame()
            .fgCalls
            .filter((call) => call.color === "warning")
            .at(-1)
            ?.text;
    }

    it("pins the output pane to the newest lines", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        const visible = visibleOutput();

        assert.ok(visible.length > 1, "the pane must show several output lines");
        assert.equal(visible.at(-1), "line 40");
        assert.ok(!visible.includes("line 1"), "the pane must not start at the oldest line");
        assert.equal(pausedMarker(), undefined);
    });

    it("shows the newest output of a short job without a pause marker", async () => {
        await addJob("job-1", "echo done", lineOutput(3));

        assert.deepEqual(visibleOutput(), ["line 1", "line 2", "line 3"]);
        assert.equal(pausedMarker(), undefined);
    });

    it("renders every settled status with its own colour", () => {
        // Contract: the inspector colours a job by status in both panes - completed is success,
        // failed is the error colour, and a killed background shell is muted.
        shellManager.startJob({ id: "completed", command: "echo done", cwd: "/work", controller: new AbortController() });
        shellManager.settleJob("completed", { type: "completed", exitCode: 0 });
        shellManager.startJob({ id: "failed", command: "exit 1", cwd: "/work", controller: new AbortController() });
        shellManager.settleJob("failed", { type: "failed", error: "Command exited with code 1", exitCode: 1 });
        shellManager.startJob({ id: "killed", command: "sleep 60", cwd: "/work", controller: new AbortController() });
        shellManager.settleJob("killed", { type: "killed", error: "timeout:1" });

        const { fgCalls } = frame();

        assert.ok(fgCalls.some((call) => call.color === "success" && call.text === "completed"));
        assert.ok(fgCalls.some((call) => call.color === "error" && call.text === "failed"));
        assert.ok(fgCalls.some((call) => call.color === "muted" && call.text === "killed"));
    });

    it("scrolls one line back with Shift+Up and pauses the newest output", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));
        const redrawsBefore = renderRequests;

        press(SHIFT_UP);

        const visible = visibleOutput();

        assert.equal(visible.at(-1), "line 39");
        assert.ok(!visible.includes("line 40"), "the newest line must leave the pane while paused");
        assert.equal(pausedMarker(), " · paused ↑1");
        assert.equal(renderRequests, redrawsBefore + 1, "scrolling must ask for a redraw");
    });

    it("scrolls one line back with Shift+K", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        press("K");

        assert.equal(visibleOutput().at(-1), "line 39");
    });

    it("scrolls one line forward with Shift+Down and leaves the pause", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        press(SHIFT_UP);
        press(SHIFT_UP);
        assert.equal(visibleOutput().at(-1), "line 38");

        press(SHIFT_DOWN);

        assert.equal(visibleOutput().at(-1), "line 39");
        assert.equal(pausedMarker(), " · paused ↑1");
    });

    it("resumes following once the newest line is in view again", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        press(SHIFT_UP);
        press("J");

        assert.equal(pausedMarker(), undefined);
        assert.equal(visibleOutput().at(-1), "line 40");

        await writeOutput("job-1", "\nline 41");

        assert.equal(visibleOutput().at(-1), "line 41", "following means new output moves the pane");
    });

    it("keeps a paused pane anchored while new output streams in", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        press(SHIFT_UP);
        press(SHIFT_UP);
        const paused = visibleOutput();

        await writeOutput("job-1", "\nline 41");

        assert.deepEqual(visibleOutput(), paused, "a paused pane must not drift with the tail");
        assert.equal(pausedMarker(), " · paused ↑3");
    });

    it("does not scroll past the oldest line", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        for (let i = 0; i < 100; i++) {
            press(SHIFT_UP);
        }

        assert.equal(visibleOutput().at(0), "line 1");
    });

    it("ignores scrolling on a job with nothing to scroll", async () => {
        await addJob("job-1", "echo done", lineOutput(3));

        press(SHIFT_UP);

        assert.deepEqual(visibleOutput(), ["line 1", "line 2", "line 3"]);
        assert.equal(pausedMarker(), undefined);
    });

    it("jumps to the oldest line with Home and back to the newest with End", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        press(HOME);

        assert.equal(visibleOutput().at(0), "line 1");
        assert.ok(pausedMarker()?.startsWith(" · paused ↑"));

        press(END);

        assert.equal(visibleOutput().at(-1), "line 40");
        assert.equal(pausedMarker(), undefined);
    });

    it("shows the newest output of the selected job after switching jobs", async () => {
        await addJob("job-a", "tail -f a.log", lineOutput(40));
        await addJob("job-b", "echo b", lineOutput(3));

        press(SHIFT_UP);
        assert.equal(pausedMarker(), " · paused ↑1");

        press("j");

        assert.deepEqual(visibleOutput(), ["line 1", "line 2", "line 3"]);
        assert.equal(pausedMarker(), undefined);

        press("k");

        assert.equal(visibleOutput().at(-1), "line 40", "the previous job must reset to its newest output");
        assert.equal(pausedMarker(), undefined);
    });

    it("keeps plain j and k on job selection instead of scrolling", async () => {
        await addJob("job-a", "tail -f a.log", lineOutput(40));
        await addJob("job-b", "echo b", lineOutput(3));

        press("j");

        assert.deepEqual(visibleOutput(), ["line 1", "line 2", "line 3"]);
    });

    it("shows the last chunk even when the job settles before the next frame", async () => {
        // Contract: the TUI renders on a timer, and xterm parses queued writes on the first timer
        // after the write, so a job that streams and exits in one turn still shows its last line.
        shellManager.startJob({ id: "job-1", command: "npm run build", cwd: "/work", controller: new AbortController() });
        shellManager.appendOutput("job-1", "step 1\rstep 2");
        shellManager.settleJob("job-1", { type: "completed", exitCode: 0 });

        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(visibleOutput().at(-1), "step 2");
    });

    it("renders control sequences as the screen state they produce", async () => {
        // Regression: \r redraws, SGR colour and OSC titles used to reach the pane as plain text,
        // so a progress bar stacked one line per redraw and escape bytes leaked into the TUI frame.
        await addJob(
            "job-1",
            "npm run build",
            "\x1b[32mflip-pairwise: 8%\x1b[0m\r" +
            "flip-pairwise: 61%\r" +
            "flip-pairwise: 100%\x1b[K\n" +
            "\x1b]0;build\x07done\n",
        );

        assert.deepEqual(visibleOutput(), ["flip-pairwise: 100%", "done"]);
        assert.ok(
            !visibleOutput().some((line) => line.includes("\x1b")),
            "no escape sequence may survive into the pane",
        );
    });

    it("keeps a line wider than the emulator as one pane line", async () => {
        // The emulator wraps at 120 columns; the pane must still see one logical line, not the rows
        // that wrap produced.
        await addJob("job-1", "cat wide.txt", `${"x".repeat(400)}\n`);

        const visible = visibleOutput();

        assert.equal(visible.length, 1, "a wrapped line must not fill the pane with rows");
        assert.ok(visible[0]!.startsWith("x".repeat(50)));
    });

    it("says that a running job has no output yet", async () => {
        shellManager.startJob({ id: "job-1", command: "sleep 5", cwd: "/work", controller: new AbortController() });

        assert.deepEqual(visibleOutput(), ["no output yet"]);
    });

    it("keeps the last screen of a settled job", async () => {
        await addJob("job-1", "npm test", "suite 1 ok\n");
        shellManager.settleJob("job-1", { type: "completed", exitCode: 0 });

        assert.deepEqual(visibleOutput(), ["suite 1 ok"]);
    });

    it("truncates a wide line to the pane without changing the job's screen", async () => {
        // The pane decides what to cut, so the emulator keeps the full logical line: line count and
        // scrolling stay independent of the pane's width.
        const wide = "x".repeat(400);
        await addJob("job-1", "cat wide.txt", `${wide}\n`);

        const narrow = inspector.render(70);

        assert.ok(narrow.every((line) => visibleWidth(line) === 70), "every row must fit the narrow frame");
        assert.ok(narrow.some((line) => line.includes("…")), "the pane must mark the truncation");
        assert.deepEqual(shellManager.getScreenLines("job-1"), [wide]);
    });
});
