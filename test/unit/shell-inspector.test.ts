/**
 * Unit tests for the shell inspector's keys: output scrolling, killing and clearing the selected shell.
 *
 * The inspector renders the selected job's output tail in a fixed pane, and the scroll keys shift
 * which lines that pane shows: Shift+Up/Shift+K one line older, Shift+Down/Shift+J one line newer,
 * Home to the oldest line, End back to the newest. Following the newest output is the default, and
 * it is what the pane returns to once the newest line is in view again - scrolling is a pause, not
 * a mode. Switching jobs always shows the newly selected job's newest output.
 *
 * `x` settles the selected job through the manager as killed, with the reason the pane shows. It is
 * a destructive key without a confirmation step, so the tests pin what it must and must not touch:
 * the selected shell only - never one that already settled, and never the same shell twice - and the
 * killed shell stays listed and readable afterwards.
 *
 * `c` clears the selected settled shell (`completed`, `failed` or `killed`) out of the manager. A
 * running shell is refused, and either outcome answers in the footer: the notice replaces the key
 * hints until it expires on its own. The tests also pin what clearing must not do: touch the
 * process, clear a shell that is not selected, or reset the selection / output pause that belongs
 * to another shell.
 *
 * The tests render the real component against the real `shellManager` singleton with a recording
 * stub theme, so assertions read plain strings (no ANSI) and the paused marker can be checked by
 * the color it asks for. `test/integration/inspector-kill.test.ts` presses the same key against a
 * real background shell; the overlay, key routing and the real TUI are out of scope here, and
 * `test/tui` observes those by hand.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

import { ShellInspector } from "../../src/shell/shell-inspector.ts";
import { shellManager, type ShellJobOutcome } from "../../src/shell/shell-manager.ts";
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

/** Output of `count` prefixed, numbered lines, oldest first. */
function prefixedOutput(prefix: string, count: number): string {
    return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
}

/** Write a job's output and wait until the emulator has executed it. */
async function writeOutput(id: string, output: string): Promise<void> {
    shellManager.appendOutput(id, output);
    await readJobScreen(id);
}

/** Add a running job whose output is already complete for the purposes of rendering. */
async function addJob(id: string, command: string, output: string, label?: string): Promise<void> {
    shellManager.startJob({ id, command, label, cwd: "/work", controller: new AbortController() });
    await writeOutput(id, output);
}

/** Add a job and settle it, so the clear key can act on it. */
async function addSettledJob(
    id: string,
    command: string,
    output: string,
    outcome: ShellJobOutcome = { type: "completed", exitCode: 0 },
): Promise<void> {
    await addJob(id, command, output);
    shellManager.settleJob(id, outcome);
}

/** The right pane of one rendered line; empty for the separator and border lines. */
function rightCell(line: string): string {
    const cells = line.split("│");
    return cells.length === 4 ? cells[2]!.trim() : "";
}

/** The left pane of one rendered body line; empty for the frame and separator lines. */
function leftCell(line: string): string {
    const cells = line.split("│");
    return cells.length === 4 ? cells[1]!.trim() : "";
}

describe("shell inspector", () => {
    let stub: StubTheme;
    let inspector: ShellInspector;
    let renderRequests: number;
    let closeRequests: number;

    beforeEach(() => {
        shellManager.clearAllJobs();
        stub = createStubTheme();
        renderRequests = 0;
        closeRequests = 0;

        inspector = createInspector();
    });

    /** Build the inspector the way the `/shell` overlay factory does. */
    function createInspector(): ShellInspector {
        return new ShellInspector(
            { ui: { theme: stub.theme } } as unknown as ExtensionContext,
            () => {
                renderRequests += 1;
            },
            () => {
                closeRequests += 1;
            },
            () => TERMINAL_ROWS,
            stub.theme,
        );
    }

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
            .fgCalls.filter((call) => call.color === "warning")
            .at(-1)?.text;
    }

    /**
     * Send one mouse event after a render, at overlay-local cell coordinates, the way fullscreen
     * mode delivers it to the overlay. The coordinates are read off the rendered frame by the
     * callers, so the tests hit what the user would see rather than a recomputed layout.
     */
    function mouse(
        type: TuiMouseEvent["type"],
        x: number,
        y: number,
        extra: Partial<TuiMouseEvent> = {},
    ): ReturnType<ShellInspector["handleMouse"]> {
        const lines = inspector.render(WIDTH);

        return inspector.handleMouse({
            type,
            button: type === "wheel" ? "none" : "left",
            x,
            y,
            screenX: x + 5,
            screenY: y + 2,
            width: WIDTH,
            height: lines.length,
            shift: false,
            alt: false,
            ctrl: false,
            ...extra,
        });
    }

    /** A cell inside the output pane: the first output row, a few columns into the right pane. */
    function outputCell(): { x: number; y: number } {
        const lines = inspector.render(WIDTH);
        const y = lines.findIndex((line) => rightCell(line).startsWith("Output ·")) + 1;

        return { x: lines[y]!.indexOf("│", 1) + 3, y };
    }

    /** A cell on the job row whose left pane mentions `text`. */
    function jobCell(text: string): { x: number; y: number } {
        const y = inspector.render(WIDTH).findIndex((line) => leftCell(line).includes(text));

        assert.ok(y >= 0, `the job list must show ${text}`);

        return { x: 4, y };
    }

    /** The back-to-bottom label on the bottom separator, if the newest frame drew one. */
    function backToBottomCell(): { x: number; y: number } | undefined {
        const lines = inspector.render(WIDTH);
        const y = lines.length - 3;
        const x = lines[y]!.indexOf("[ ↓ Back to bottom");

        return x < 0 ? undefined : { x, y };
    }

    /** The footer row of the newest frame: the key hints, or the notice that replaced them. */
    function footerLine(): string {
        return inspector.render(WIDTH).at(-2) ?? "";
    }

    it("pins the output pane to the newest lines", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        const visible = visibleOutput();

        assert.ok(
            visible.length > 1,
            `the pane must show several output lines, got ${visible.length}`,
        );
        assert.equal(visible.at(-1), "line 40", "following mode must end on the newest line");
        assert.ok(
            !visible.includes("line 1"),
            `the pane must not start at the oldest line, got ${JSON.stringify(visible)}`,
        );
        assert.equal(
            pausedMarker(),
            undefined,
            "following the newest output must not draw a pause marker",
        );
    });

    it("shows the newest output of a short job without a pause marker", async () => {
        await addJob("job-1", "echo done", lineOutput(3));

        assert.deepEqual(
            visibleOutput(),
            ["line 1", "line 2", "line 3"],
            "a short job must show all its output",
        );
        assert.equal(pausedMarker(), undefined, "a short job has nothing to pause");
    });

    it("renders every settled status with its own colour", () => {
        // Contract: the inspector colours a job by status in both panes - completed is success,
        // failed is the error colour, and a killed background shell is muted.
        shellManager.startJob({
            id: "completed",
            command: "echo done",
            cwd: "/work",
            controller: new AbortController(),
        });
        shellManager.settleJob("completed", { type: "completed", exitCode: 0 });
        shellManager.startJob({
            id: "failed",
            command: "exit 1",
            cwd: "/work",
            controller: new AbortController(),
        });
        shellManager.settleJob("failed", {
            type: "failed",
            error: "Command exited with code 1",
            exitCode: 1,
        });
        shellManager.startJob({
            id: "killed",
            command: "sleep 60",
            cwd: "/work",
            controller: new AbortController(),
        });
        shellManager.settleJob("killed", { type: "killed", error: "timeout:1" });

        const { fgCalls } = frame();

        assert.ok(
            fgCalls.some((call) => call.color === "success" && call.text === "completed"),
            `a completed shell must be drawn in the success colour, got ${JSON.stringify(fgCalls)}`,
        );
        assert.ok(
            fgCalls.some((call) => call.color === "error" && call.text === "failed"),
            `a failed shell must be drawn in the error colour, got ${JSON.stringify(fgCalls)}`,
        );
        assert.ok(
            fgCalls.some((call) => call.color === "muted" && call.text === "killed"),
            `a killed shell must be drawn muted, got ${JSON.stringify(fgCalls)}`,
        );
    });

    it("scrolls one line back with Shift+Up and pauses the newest output", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));
        const redrawsBefore = renderRequests;

        press(SHIFT_UP);

        const visible = visibleOutput();

        assert.equal(visible.at(-1), "line 39", "Shift+Up must move the pane one line back");
        assert.ok(
            !visible.includes("line 40"),
            `the newest line must leave the pane while paused, got ${JSON.stringify(visible)}`,
        );
        assert.equal(pausedMarker(), " · paused ↑1", "the pane must mark how far it is paused");
        assert.equal(renderRequests, redrawsBefore + 1, "scrolling must ask for a redraw");
    });

    it("scrolls one line back with Shift+K", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        press("K");

        assert.equal(visibleOutput().at(-1), "line 39", "Shift+K must scroll like Shift+Up");
    });

    it("scrolls one line forward with Shift+Down and leaves the pause", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        press(SHIFT_UP);
        press(SHIFT_UP);
        assert.equal(visibleOutput().at(-1), "line 38", "two scrolls must move two lines back");

        press(SHIFT_DOWN);

        assert.equal(visibleOutput().at(-1), "line 39", "Shift+Down must move one line forward");
        assert.equal(
            pausedMarker(),
            " · paused ↑1",
            "the pause marker must count down with the scroll",
        );
    });

    it("resumes following once the newest line is in view again", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        press(SHIFT_UP);
        press("J");

        assert.equal(
            pausedMarker(),
            undefined,
            "returning to the newest line must clear the pause",
        );
        assert.equal(visibleOutput().at(-1), "line 40", "the pane must show the newest line again");

        await writeOutput("job-1", "\nline 41");

        assert.equal(
            visibleOutput().at(-1),
            "line 41",
            "following means new output moves the pane",
        );
    });

    it("keeps a paused pane anchored while new output streams in", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        press(SHIFT_UP);
        press(SHIFT_UP);
        const paused = visibleOutput();

        await writeOutput("job-1", "\nline 41");

        assert.deepEqual(visibleOutput(), paused, "a paused pane must not drift with the tail");
        assert.equal(
            pausedMarker(),
            " · paused ↑3",
            "the paused marker must keep its distance while output continues",
        );
    });

    it("does not scroll past the oldest line", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        for (let i = 0; i < 100; i++) {
            press(SHIFT_UP);
        }

        assert.equal(visibleOutput().at(0), "line 1", "scrolling must stop at the oldest line");
    });

    it("ignores scrolling on a job with nothing to scroll", async () => {
        await addJob("job-1", "echo done", lineOutput(3));

        press(SHIFT_UP);

        assert.deepEqual(
            visibleOutput(),
            ["line 1", "line 2", "line 3"],
            "a pane with nothing to scroll must stay put",
        );
        assert.equal(pausedMarker(), undefined, "an ignored scroll must not pause the pane");
    });

    it("jumps to the oldest line with Home and back to the newest with End", async () => {
        await addJob("job-1", "tail -f app.log", lineOutput(40));

        press(HOME);

        assert.equal(visibleOutput().at(0), "line 1", "Home must jump to the oldest line");
        assert.ok(
            pausedMarker()?.startsWith(" · paused ↑"),
            `Home must mark the pane as paused, got ${JSON.stringify(pausedMarker())}`,
        );

        press(END);

        assert.equal(visibleOutput().at(-1), "line 40", "End must jump back to the newest line");
        assert.equal(pausedMarker(), undefined, "End must resume following the newest output");
    });

    it("shows the newest output of the selected job after switching jobs", async () => {
        await addJob("job-a", "tail -f a.log", lineOutput(40));
        await addJob("job-b", "echo b", lineOutput(3));

        press(SHIFT_UP);
        assert.equal(pausedMarker(), " · paused ↑1", "the first job must pause one line back");

        press("j");

        assert.deepEqual(
            visibleOutput(),
            ["line 1", "line 2", "line 3"],
            "switching jobs must show the new job's output",
        );
        assert.equal(
            pausedMarker(),
            undefined,
            "the new job must start following its newest output",
        );

        press("k");

        assert.equal(
            visibleOutput().at(-1),
            "line 40",
            "the previous job must reset to its newest output",
        );
        assert.equal(pausedMarker(), undefined, "switching back must not restore the old pause");
    });

    it("reopens on the shell that was selected when it closed", async () => {
        await addJob("job-a", "cmd-a", prefixedOutput("a", 3));
        await addJob("job-b", "cmd-b", prefixedOutput("b", 3));

        press("j"); // select job-b

        inspector.dispose();
        inspector = createInspector();

        assert.deepEqual(
            visibleOutput(),
            ["b 1", "b 2", "b 3"],
            "reopening the inspector must show the shell that was selected before",
        );
        assert.ok(
            frame()
                .lines.map(leftCell)
                .some((cell) => cell.startsWith("› ● cmd-b")),
            `the reopened inspector must highlight that shell, got ${JSON.stringify(frame().lines.map(leftCell))}`,
        );
    });

    it("reopens on the first shell after the job list was cleared", async () => {
        await addJob("job-a", "cmd-a", prefixedOutput("a", 3));
        await addJob("job-b", "cmd-b", prefixedOutput("b", 3));

        press("j"); // select job-b

        inspector.dispose();
        shellManager.clearAllJobs();
        await addJob("job-c", "cmd-c", prefixedOutput("c", 3));
        inspector = createInspector();

        assert.deepEqual(
            visibleOutput(),
            ["c 1", "c 2", "c 3"],
            "a cleared job list must reopen on its first shell again",
        );
    });

    it("keeps plain j and k on job selection instead of scrolling", async () => {
        await addJob("job-a", "tail -f a.log", lineOutput(40));
        await addJob("job-b", "echo b", lineOutput(3));

        press("j");

        assert.deepEqual(
            visibleOutput(),
            ["line 1", "line 2", "line 3"],
            "plain j must select a job, not scroll the pane",
        );
    });

    it("shows the last chunk even when the job settles before the next frame", async () => {
        // Contract: the TUI renders on a timer, and xterm parses queued writes on the first timer
        // after the write, so a job that streams and exits in one turn still shows its last line.
        shellManager.startJob({
            id: "job-1",
            command: "npm run build",
            cwd: "/work",
            controller: new AbortController(),
        });
        shellManager.appendOutput("job-1", "step 1\rstep 2");
        shellManager.settleJob("job-1", { type: "completed", exitCode: 0 });

        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(
            visibleOutput().at(-1),
            "step 2",
            "the last chunk must reach the pane even when the job settled",
        );
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

        assert.deepEqual(
            visibleOutput(),
            ["flip-pairwise: 100%", "done"],
            "the pane must show the executed screen, not the redraw stack",
        );
        assert.ok(
            !visibleOutput().some((line) => line.includes("\x1b")),
            `no escape sequence may survive into the pane, got ${JSON.stringify(visibleOutput())}`,
        );
    });

    it("wraps a line wider than the emulator without losing content", async () => {
        const wide = "x".repeat(400);
        await addJob("job-1", "cat wide.txt", `${wide}\n`);

        const visible = visibleOutput();

        assert.ok(visible.length > 1, "a long logical line must occupy multiple pane rows");
        assert.equal(visible.join(""), wide, "every character must remain readable");
        assert.deepEqual(
            shellManager.getScreenLines("job-1"),
            [wide],
            "pane wrapping must not change the screen",
        );
    });

    it("says that a running job has no output yet", async () => {
        shellManager.startJob({
            id: "job-1",
            command: "sleep 5",
            cwd: "/work",
            controller: new AbortController(),
        });

        assert.deepEqual(
            visibleOutput(),
            ["no output yet"],
            "a running job without output must say so",
        );
    });

    it("keeps the last screen of a settled job", async () => {
        await addJob("job-1", "npm test", "suite 1 ok\n");
        shellManager.settleJob("job-1", { type: "completed", exitCode: 0 });

        assert.deepEqual(
            visibleOutput(),
            ["suite 1 ok"],
            "a settled job must keep its last screen",
        );
    });

    it("kills the selected running shell with x", async () => {
        await addJob("job-a", "sleep 60", lineOutput(40));
        await addJob("job-b", "tail -f b.log", lineOutput(3));

        press("j");
        const redrawsBefore = renderRequests;

        press("x");

        const killed = shellManager.getJob("job-b");
        assert.ok(killed, "the killed shell must stay listed");
        assert.equal(killed.status, "killed", "x must settle the selected shell as killed");
        assert.equal(
            killed.error,
            "Shell killed by user",
            "the kill must record the user's reason",
        );
        assert.equal(
            killed.controller.signal.aborted,
            true,
            "killing a shell must abort its process tree",
        );
        assert.equal(
            shellManager.getJob("job-a")?.status,
            "running",
            "only the selected shell is killed",
        );
        assert.deepEqual(
            shellManager.getAllJobsStatusStat(),
            { runningCount: 1, completedCount: 0, failedCount: 0, killedCount: 1 },
            "the kill must move only the selected shell's counter",
        );
        assert.equal(renderRequests, redrawsBefore + 1, "the kill must redraw the pane");
    });

    it("kills the first shell when the selection was never moved", async () => {
        await addJob("job-a", "sleep 60", lineOutput(40));
        await addJob("job-b", "tail -f b.log", lineOutput(3));

        press("x");

        assert.equal(
            shellManager.getJob("job-a")?.status,
            "killed",
            "the selection starts on the first shell",
        );
        assert.equal(
            shellManager.getJob("job-b")?.status,
            "running",
            "the unselected shell must survive",
        );
        assert.equal(
            visibleOutput().at(-1),
            "line 40",
            "the pane must keep showing the shell that was killed",
        );
    });

    it("keeps a killed shell listed, selected and readable", async () => {
        await addJob("job-a", "sleep 60", lineOutput(40));
        await addJob("job-b", "tail -f b.log", lineOutput(3));

        press("j");
        press("x");

        const { lines } = frame();
        const cells = lines.map(rightCell);

        assert.ok(
            lines.some((line) => line.includes("2 shells · 1 running")),
            `the killed shell must stay in the list: ${JSON.stringify(lines[1])}`,
        );
        assert.ok(
            cells.includes("Error: Shell killed by user"),
            `the pane must name the kill: ${JSON.stringify(cells)}`,
        );
        assert.deepEqual(
            visibleOutput(),
            ["line 1", "line 2", "line 3"],
            "the killed shell's output must stay readable",
        );
    });

    it("refuses to kill a shell that already settled", async () => {
        await addJob("job-1", "echo done", lineOutput(1));
        shellManager.settleJob("job-1", { type: "completed", exitCode: 0 });

        press("x");

        const job = shellManager.getJob("job-1");
        assert.ok(job, "the settled shell must stay listed");
        assert.equal(job.status, "completed", "a settled shell must not become killed");
        assert.equal(job.exitCode, 0, "a refused kill must not change the exit code");
        assert.equal(job.error, undefined, "a refused kill must not record a reason");
        assert.equal(
            job.controller.signal.aborted,
            false,
            "a refused kill must not abort anything",
        );
        assert.deepEqual(
            shellManager.getAllJobsStatusStat(),
            { runningCount: 0, completedCount: 1, failedCount: 0, killedCount: 0 },
            "a refused kill must not move a counter",
        );
    });

    it("refuses a repeated kill of the same shell", async () => {
        await addJob("job-1", "sleep 60", lineOutput(1));

        press("x");
        press("x");

        assert.equal(
            shellManager.getJob("job-1")?.status,
            "killed",
            "the first x must settle the shell as killed",
        );
        assert.equal(
            shellManager.getJob("job-1")?.error,
            "Shell killed by user",
            "the second x must not rewrite the reason",
        );
        assert.deepEqual(
            shellManager.getAllJobsStatusStat(),
            { runningCount: 0, completedCount: 0, failedCount: 0, killedCount: 1 },
            "the second kill must not count the shell twice",
        );
    });

    it("advertises the kill key in the footer", async () => {
        await addJob("job-1", "sleep 60", lineOutput(1));

        const footer = frame().lines.at(-2) ?? "";

        assert.ok(footer.includes("x to kill"), `the footer must show the kill key: ${footer}`);
        assert.ok(
            footer.includes("Esc to close"),
            `the footer must still show the close key: ${footer}`,
        );
    });

    for (const status of ["completed", "failed", "killed"] as const) {
        it(`clears a ${status} shell with c and reports success`, async () => {
            const outcome: ShellJobOutcome =
                status === "completed"
                    ? { type: "completed", exitCode: 0 }
                    : status === "failed"
                      ? { type: "failed", error: "boom", exitCode: 1 }
                      : { type: "killed", error: "manual kill" };
            await addSettledJob("job-1", "npm test", "suite ok\n", outcome);

            press("c");

            assert.equal(
                shellManager.getJob("job-1")?.id,
                undefined,
                "the cleared shell must leave the manager",
            );
            assert.deepEqual(
                shellManager.getAllJobsStatusStat(),
                {
                    runningCount: 0,
                    completedCount: 0,
                    failedCount: 0,
                    killedCount: 0,
                },
                "clearing the last shell must empty every counter",
            );

            const { lines, fgCalls } = frame();
            const footer = lines.at(-2) ?? "";
            const success = "Cleared npm test";

            assert.ok(footer.includes(success), `the footer must confirm the clear: ${footer}`);
            assert.ok(
                !footer.includes("x to kill"),
                `the notice must replace the key hints, got ${JSON.stringify(footer)}`,
            );
            assert.ok(
                fgCalls.some((call) => call.color === "success" && call.text.includes(success)),
                `the confirmation must use the success colour, got ${JSON.stringify(fgCalls)}`,
            );
        });
    }

    it("refuses to clear a running shell with the accent notice", async () => {
        await addJob("job-1", "sleep 60", "still running\n");
        const controller = shellManager.getJob("job-1")!.controller;
        const redrawsBefore = renderRequests;

        press("c");

        const job = shellManager.getJob("job-1");
        assert.ok(job, "a running shell must stay in the manager");
        assert.equal(job.status, "running", "a running shell must not be cleared");
        assert.equal(controller.signal.aborted, false, "the refusal must not touch the process");
        assert.deepEqual(
            shellManager.getAllJobsStatusStat(),
            {
                runningCount: 1,
                completedCount: 0,
                failedCount: 0,
                killedCount: 0,
            },
            "a refused clear must not move a counter",
        );
        assert.equal(renderRequests, redrawsBefore + 1, "the refusal must repaint the footer");

        const { lines, fgCalls } = frame();
        const footer = lines.at(-2) ?? "";
        const refusal = "Clear failed, only completed, failed, or killed";

        assert.ok(footer.includes(refusal), `the footer must explain the refusal: ${footer}`);
        assert.ok(
            !footer.includes("x to kill"),
            `the notice must replace the key hints, got ${JSON.stringify(footer)}`,
        );
        assert.ok(
            fgCalls.some((call) => call.color === "accent" && call.text.includes(refusal)),
            `the refusal must use the accent colour, got ${JSON.stringify(fgCalls)}`,
        );
    });

    it("hides the notice by itself and restores the key hints", async (t) => {
        await addSettledJob("job-1", "echo done", "done\n");

        // Timers are mocked only after the job's terminal write flushed: xterm parses its write
        // queue through setTimeout, so mocking any earlier would hang the setup. Ticking a generous
        // span keeps the assertion independent of how long the notice is meant to live.
        t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

        press("c");

        assert.ok(
            footerLine().includes("Cleared echo done"),
            `the notice must be visible right after the clear, got ${JSON.stringify(footerLine())}`,
        );

        t.mock.timers.tick(30_000);

        assert.ok(
            !footerLine().includes("Cleared echo done"),
            `the notice must disappear on its own, got ${JSON.stringify(footerLine())}`,
        );
        assert.ok(
            footerLine().includes("x to kill"),
            `the key hints must come back, got ${JSON.stringify(footerLine())}`,
        );
    });

    it("keeps the selection position when a cleared shell slides the next one up", async () => {
        await addSettledJob("job-a", "cmd-a", "output-a\n");
        await addSettledJob("job-b", "cmd-b", "output-b\n");
        await addSettledJob("job-c", "cmd-c", "output-c\n");

        press("j"); // select job-b
        press("c");

        assert.deepEqual(
            shellManager.getAllJobsList().map((job) => job.id),
            ["job-a", "job-c"],
            "clearing the middle shell must keep the order of the rest",
        );
        assert.deepEqual(
            visibleOutput(),
            ["output-c"],
            "the shell that took the cleared position must be selected",
        );
        assert.ok(
            frame()
                .lines.map(leftCell)
                .some((cell) => cell.startsWith("› ● cmd-c")),
            `the job list must highlight the shell that took the cleared position, got ${JSON.stringify(frame().lines.map(leftCell))}`,
        );
    });

    it("selects the new last shell when the cleared one was last", async () => {
        await addSettledJob("job-a", "cmd-a", "output-a\n");
        await addSettledJob("job-b", "cmd-b", "output-b\n");

        press("j"); // select job-b, the last shell
        press("c");

        assert.deepEqual(
            shellManager.getAllJobsList().map((job) => job.id),
            ["job-a"],
            "clearing the last shell must leave the earlier one",
        );
        assert.deepEqual(
            visibleOutput(),
            ["output-a"],
            "the pane must fall back to the surviving shell's output",
        );
    });

    it("follows the newly selected shell's newest output after clearing a paused shell", async () => {
        await addSettledJob("job-a", "tail -f a.log", prefixedOutput("a", 40));
        await addSettledJob("job-b", "tail -f b.log", prefixedOutput("b", 40));

        press("j"); // select job-b
        press(SHIFT_UP);
        assert.equal(pausedMarker(), " · paused ↑1", "the selected shell must start paused");

        press("c");

        assert.equal(shellManager.getJob("job-b")?.id, undefined, "c must clear the paused shell");
        assert.equal(
            pausedMarker(),
            undefined,
            "the newly selected shell must follow its newest output",
        );
        assert.equal(
            visibleOutput().at(-1),
            "a 40",
            "the pane must show the surviving shell's newest line",
        );
    });

    it("keeps the inspector open on an empty frame after the last shell is cleared", async () => {
        await addSettledJob("job-1", "echo done", "done\n");

        press("c");

        const lines = inspector.render(WIDTH);

        assert.ok(
            lines.length > 0,
            `the overlay must keep drawing a frame, got ${lines.length} lines`,
        );
        assert.ok(lines[0]!.includes("┌"), `the top border must stay: ${JSON.stringify(lines)}`);
        assert.ok(
            lines.at(-1)!.includes("└"),
            `the bottom border must stay: ${JSON.stringify(lines)}`,
        );
        assert.ok(
            !lines.some((line) => line.includes("› ●")),
            `no job may be listed, got ${JSON.stringify(lines)}`,
        );
        assert.equal(closeRequests, 0, "clearing the last shell must not close the inspector");
        assert.ok(
            (lines.at(-2) ?? "").includes("Cleared echo done"),
            `the empty frame must still show the notice, got ${JSON.stringify(lines.slice(-2))}`,
        );

        // An empty list must not make the keys throw or resurrect a job.
        assert.doesNotThrow(() => {
            press("j");
            press("K");
            press("J");
            press(HOME);
            press(END);
            press("x");
            press("c");
        }, "an empty job list must leave every key harmless");
        assert.equal(
            shellManager.getAllJobsList().length,
            0,
            "the keys must not resurrect a cleared shell",
        );

        press("\x1b"); // Esc
        assert.equal(closeRequests, 1, "Esc must still close the empty inspector");
    });

    it("advertises the clear key in the footer", async () => {
        await addSettledJob("job-1", "echo done", "done\n");

        const footer = footerLine();

        assert.ok(footer.includes("c to clear"), `the footer must show the clear key: ${footer}`);
        assert.ok(
            footer.includes("x to kill"),
            `the footer must still show the kill key: ${footer}`,
        );
        assert.ok(
            footer.includes("Esc to close"),
            `the footer must still show the close key: ${footer}`,
        );
    });

    it("wraps wide characters to a narrow pane and reflows on resize", async () => {
        const wide = "こんにちは🙂".repeat(30);
        await addJob("job-1", "cat wide.txt", `${wide}\nnext\n`);

        for (const width of [70, WIDTH]) {
            const lines = inspector.render(width);
            const cells = lines.map(rightCell);
            const header = cells.findIndex((cell) => cell.startsWith("Output ·"));
            const output = cells.slice(header + 1).filter(Boolean);

            assert.ok(
                lines.every((line) => visibleWidth(line) === width),
                "every row must fit the frame",
            );
            assert.equal(
                output.slice(0, -1).join(""),
                wide,
                "wrapping must preserve wide characters",
            );
            assert.equal(output.at(-1), "next", "explicit line breaks must stay separate");
            assert.ok(
                output.every((line) => !line.includes("…")),
                "output must not contain truncation markers",
            );
        }
        assert.deepEqual(shellManager.getScreenLines("job-1"), [wide, "next"]);
    });

    it("scrolls within a logical line taller than the output viewport", async () => {
        const wide = "a".repeat(1500) + "THE-END";
        await addJob("job-1", "cat wide.txt", `${wide}\n`);

        const tail = visibleOutput();
        assert.ok(
            tail.at(-1)!.endsWith("THE-END"),
            "the default view must follow the wrapped tail",
        );

        press(SHIFT_UP);
        assert.deepEqual(
            visibleOutput().slice(1),
            tail.slice(0, -1),
            "scrolling must move one visual row",
        );
        assert.equal(pausedMarker(), " · paused ↑1");

        press(HOME);
        const head = visibleOutput();
        assert.ok(
            head.every((line) => /^a+$/.test(line)),
            "Home must reveal the beginning without ellipses",
        );
        await writeOutput("job-1", "later\n");
        assert.deepEqual(visibleOutput(), head, "new output must not move a paused viewport");

        press(END);
        assert.equal(visibleOutput().at(-1), "later");
        assert.equal(pausedMarker(), undefined);
    });

    describe("mouse", () => {
        it("scrolls the output by the wheel delta over the output pane", async () => {
            await addJob("job-1", "tail -f app.log", lineOutput(40));
            const { x, y } = outputCell();

            const result = mouse("wheel", x, y, { wheelDelta: -3 });

            assert.deepEqual(
                result,
                { handled: true },
                "the wheel must be claimed so the transcript behind stays put",
            );
            assert.equal(
                visibleOutput().at(-1),
                "line 37",
                "a wheel delta of -3 must move the pane three lines back",
            );
            assert.equal(
                pausedMarker(),
                " · paused ↑3",
                "wheel scrolling must pause like the keys",
            );

            mouse("wheel", x, y, { wheelDelta: 3 });

            assert.equal(
                visibleOutput().at(-1),
                "line 40",
                "scrolling forward must reach the newest line again",
            );
            assert.equal(
                pausedMarker(),
                undefined,
                "reaching the newest line must resume following",
            );
        });

        it("does not scroll the output past the oldest line with the wheel", async () => {
            await addJob("job-1", "tail -f app.log", lineOutput(40));
            const { x, y } = outputCell();

            mouse("wheel", x, y, { wheelDelta: -500 });

            assert.equal(visibleOutput().at(0), "line 1", "the wheel must stop at the oldest line");
        });

        it("moves the selection with the wheel over the job list", async () => {
            await addJob("job-a", "cmd-a", prefixedOutput("a", 3));
            await addJob("job-b", "cmd-b", prefixedOutput("b", 3));
            await addJob("job-c", "cmd-c", prefixedOutput("c", 3));
            const { x, y } = jobCell("cmd-a");

            const result = mouse("wheel", x, y, { wheelDelta: 1 });

            assert.deepEqual(result, { handled: true }, "the wheel over the list must be claimed");
            assert.deepEqual(
                visibleOutput(),
                ["b 1", "b 2", "b 3"],
                "wheel down must select the next shell",
            );

            mouse("wheel", x, y, { wheelDelta: 10 });

            assert.deepEqual(
                visibleOutput(),
                ["c 1", "c 2", "c 3"],
                "the wheel must stop at the last shell",
            );
        });

        it("selects the clicked job row", async () => {
            await addJob("job-a", "tail -f a.log", prefixedOutput("a", 40));
            await addJob("job-b", "cmd-b", prefixedOutput("b", 3));
            press(SHIFT_UP);
            const redrawsBefore = renderRequests;
            const { x, y } = jobCell("cmd-b");

            const result = mouse("press", x, y);

            assert.deepEqual(result, { handled: true }, "a press on a job row must be claimed");
            assert.equal(
                renderRequests,
                redrawsBefore + 1,
                "selecting by click must ask for a redraw",
            );
            assert.ok(
                frame()
                    .lines.map(leftCell)
                    .some((cell) => cell.startsWith("› ● cmd-b")),
                "the clicked shell must be highlighted",
            );
            assert.deepEqual(
                visibleOutput(),
                ["b 1", "b 2", "b 3"],
                "the pane must show the clicked shell",
            );
            assert.equal(
                pausedMarker(),
                undefined,
                "a newly clicked shell must follow its newest output",
            );
        });

        it("leaves presses outside the job rows to the terminal's text selection", async () => {
            await addJob("job-a", "cmd-a", prefixedOutput("a", 3));
            await addJob("job-b", "cmd-b", prefixedOutput("b", 3));
            const output = outputCell();
            const blankListRow = jobCell("cmd-b").y + 1;

            assert.equal(
                mouse("press", output.x, output.y),
                undefined,
                "a press in the output must stay selectable",
            );
            assert.equal(
                mouse("press", 4, blankListRow),
                undefined,
                "a press below the last job must not select anything",
            );
            assert.equal(
                mouse("press", 4, 1),
                undefined,
                "a press on the header must not select anything",
            );
            assert.equal(
                mouse("press", 4, jobCell("cmd-b").y, { button: "right" }),
                undefined,
                "only the primary button selects a job",
            );
            assert.deepEqual(visibleOutput(), ["a 1", "a 2", "a 3"], "the selection must not move");
        });

        it("keeps every mouse event harmless on an empty list", () => {
            inspector.render(WIDTH);

            assert.doesNotThrow(() => {
                mouse("wheel", 4, 4, { wheelDelta: 3 });
                mouse("wheel", 60, 4, { wheelDelta: -3 });
                mouse("press", 4, 3);
            }, "mouse input on an empty inspector must not throw");
        });
    });

    describe("back-to-bottom label", () => {
        it("appears on the bottom separator only while the output is paused", async () => {
            await addJob("job-1", "tail -f app.log", lineOutput(40));

            assert.equal(
                backToBottomCell(),
                undefined,
                "a following pane must not offer to go back to the bottom",
            );

            press(SHIFT_UP);
            const lines = inspector.render(WIDTH);
            const separator = lines.at(-3)!;

            assert.ok(
                separator.includes("[ ↓ Back to bottom · End ]"),
                `the paused pane must offer the label, got ${JSON.stringify(separator)}`,
            );
            assert.ok(
                separator.startsWith("├") && separator.endsWith("┤"),
                "the label must stay inside the frame",
            );
            assert.equal(visibleWidth(separator), WIDTH, "the label must not widen the frame");
            assert.equal(
                visibleOutput().length,
                outputRowsBelowHeader(lines),
                "the label must not take an output row",
            );

            press(END);

            assert.equal(
                backToBottomCell(),
                undefined,
                "the label must leave once the pane follows again",
            );
        });

        it("follows the newest output when clicked", async () => {
            await addJob("job-1", "tail -f app.log", lineOutput(40));
            press(HOME);
            const label = backToBottomCell();
            assert.ok(label, "the paused pane must draw the label");

            const result = mouse("press", label.x + 2, label.y);

            assert.deepEqual(result, { handled: true }, "a press on the label must be claimed");
            assert.equal(
                visibleOutput().at(-1),
                "line 40",
                "clicking the label must jump to the newest line",
            );
            assert.equal(pausedMarker(), undefined, "clicking the label must resume following");

            await writeOutput("job-1", "\nline 41");

            assert.equal(
                visibleOutput().at(-1),
                "line 41",
                "the pane must keep following after the click",
            );
        });

        it("ignores presses on the separator beside the label", async () => {
            await addJob("job-1", "tail -f app.log", lineOutput(40));
            press(SHIFT_UP);
            const label = backToBottomCell()!;

            assert.equal(
                mouse("press", label.x - 1, label.y),
                undefined,
                "the dashes before the label are not a button",
            );
            assert.equal(
                pausedMarker(),
                " · paused ↑1",
                "a press beside the label must keep the pause",
            );
        });

        /** Body rows below the `Output` header: the bottom separator, footer and border are not body. */
        function outputRowsBelowHeader(lines: string[]): number {
            const header = lines.findIndex((line) => rightCell(line).startsWith("Output ·"));

            return lines.length - 3 - header - 1;
        }
    });

    it("lists a labelled job by its label while the details keep the command", async () => {
        // Contract: the left pane is narrow, so a label replaces the command there; the details pane
        // still shows the full command the job runs.
        await addJob(
            "job-1",
            "python train.py --config configs/long.json",
            lineOutput(1),
            "training run",
        );

        const lines = inspector.render(WIDTH);
        const listRow = lines.map(leftCell).find((cell) => cell.startsWith("› ●"));
        const detailsCommand = lines.map(rightCell).find((cell) => cell.startsWith("● "));

        assert.ok(listRow?.startsWith("› ● training run"), `unexpected job row: ${listRow}`);
        assert.equal(
            detailsCommand,
            "● python train.py --config configs/long.json",
            "the details pane must keep the full command",
        );
    });

    it("normalizes a multiline command in both panes without changing the stored command", () => {
        // Contract: command control sequences are removed and CR/LF/TAB become normalized spaces
        // before the same job command is shown in the list and the selected-job details.
        const rawCommand = "\x1b[31mprintf\x1b[0m\t'a\r\nb'  ok\x1b]0;title\x07";
        const normalized = "printf 'a b' ok";
        shellManager.startJob({
            id: "job-1",
            command: rawCommand,
            cwd: "/work",
            controller: new AbortController(),
        });

        const lines = inspector.render(WIDTH);
        const listRow = lines.map(leftCell).find((cell) => cell.startsWith("› ●"));
        const detailsCommand = lines.map(rightCell).find((cell) => cell.startsWith("● "));

        assert.ok(
            lines.every((line) => !/[\r\n\t]/.test(line)),
            `each rendered element must contain one plain terminal row, got ${JSON.stringify(lines)}`,
        );
        assert.ok(listRow?.startsWith(`› ● ${normalized}`), `unexpected job row: ${listRow}`);
        assert.ok(listRow?.endsWith("running"), `unexpected job status: ${listRow}`);
        assert.equal(
            detailsCommand,
            `● ${normalized}`,
            "the details pane must show the same normalized command as the list",
        );
        assert.ok(
            !listRow?.includes("\x1b"),
            `terminal control sequences must not appear in the job row, got ${JSON.stringify(listRow)}`,
        );
        assert.ok(
            !detailsCommand?.includes("\x1b"),
            `terminal control sequences must not appear in the details command, got ${JSON.stringify(detailsCommand)}`,
        );
        assert.equal(
            shellManager.getJob("job-1")?.command,
            rawCommand,
            "render normalization must not rewrite the command stored on the job",
        );
    });
});
