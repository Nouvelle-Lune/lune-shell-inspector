/**
 * Unit tests for the background shell notification box.
 *
 * A settled shell reaches the transcript as one custom message that may batch several jobs, so the
 * box has to say three things at once: how the batch as a whole ended (header + band colour), what
 * each job did (`<id>: <command> · <status> · exit <code> · <duration>`), and what it printed (the
 * tail of its own output, with the rest behind the expand hint). The output is never stored twice:
 * the message text is the only copy, and details only carry the slice the box reads it from - so a
 * wrong offset would put one job's output under another job's command, which these tests pin.
 *
 * The box is rendered through the same `buildBackgroundShellNotification` the extension sends, at a
 * fixed width, against a recording stub theme: assertions read plain strings and the requested
 * colours separately, and every band row is checked to fill the transcript width exactly.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";

import { renderBackgroundShellNotificationBox } from "../../src/shell/shell-notification-box.ts";
import {
    buildBackgroundShellNotification,
    type BackgroundShellNotification,
    type BackgroundShellNotificationDetails,
} from "../../src/shell/shell-notification.ts";

/** Transcript width every test renders at: wide enough that only long commands are cut. */
const WIDTH = 80;

interface StubTheme {
    theme: Theme;
    fgCalls: { color: string; text: string }[];
    bgCalls: { color: string; text: string }[];
}

/** Theme stub: colours become plain text, and every `fg`/`bg` call is recorded. */
function createStubTheme(): StubTheme {
    const fgCalls: { color: string; text: string }[] = [];
    const bgCalls: { color: string; text: string }[] = [];

    const theme = {
        fg: (color: string, text: string) => {
            fgCalls.push({ color, text });
            return text;
        },
        bg: (color: string, text: string) => {
            bgCalls.push({ color, text });
            return text;
        },
        bold: (text: string) => text,
    } as unknown as Theme;

    return { theme, fgCalls, bgCalls };
}

/** One settled job with every field the notification carries. */
function job(overrides: Partial<BackgroundShellNotification> = {}): BackgroundShellNotification {
    return {
        jobId: "job-1",
        jobCommand: "npm run build",
        jobStatus: "completed",
        jobExitCode: 0,
        jobError: undefined,
        jobOutput: "out\n",
        jobDurationMs: 4200,
        ...overrides,
    };
}

/** Render one batch and return the box rows without their band padding. */
function renderRows(
    batch: readonly BackgroundShellNotification[],
    options: { expanded?: boolean; outputPad?: number } = {},
): { rows: string[]; lines: string[]; fgCalls: StubTheme["fgCalls"]; bgCalls: StubTheme["bgCalls"] } {
    const { content, details } = buildBackgroundShellNotification(batch);
    const stub = createStubTheme();
    const component = renderBackgroundShellNotificationBox(
        { content, details },
        { expanded: options.expanded ?? false, outputPad: options.outputPad ?? 1 },
        stub.theme,
    );

    assert.ok(component, "guard: the batch must render a box");

    const lines = component.render(WIDTH);

    return {
        lines,
        rows: lines.map((line) => line.trimEnd()),
        fgCalls: stub.fgCalls,
        bgCalls: stub.bgCalls,
    };
}

describe("background shell notification box", () => {
    it("renders the header, the job row and the output tail with the expand hint", () => {
        const output = Array.from({ length: 8 }, (_, index) => `out ${index + 1}`).join("\n") + "\n";
        const { rows, lines, fgCalls, bgCalls } = renderRows([job({ jobOutput: output })]);

        assert.deepEqual(rows, [
            "",
            " ● 1 background shell settled",
            " npm run build · completed · exit 0 · 4.2s",
            "     out 4",
            "     out 5",
            "     out 6",
            "     out 7",
            "     out 8",
            "     … 3 earlier lines · ctrl+o to expand",
            "",
        ]);

        // The band is a full-width tool-result block: no row may be wider or narrower than pi's
        // transcript, or the background would end in the middle of a line.
        for (const line of lines) {
            assert.equal(visibleWidth(line), WIDTH, `band row must fill the width: ${JSON.stringify(line)}`);
        }

        assert.deepEqual(bgCalls.map(({ color }) => color), new Array(lines.length).fill("toolSuccessBg"));

        // Call order is not part of the contract (the row measures its suffix before it colours the
        // prefix); which colours are asked for is.
        const colours = fgCalls.map(({ color, text }) => `${color}:${text}`);
        const expected = [
            "success:●",
            "success:1 background shell settled",
            "text:npm run build",
            "dim: · ",
            "success:completed",
            "success:exit 0",
            "muted:4.2s",
            "toolOutput:out 4",
            "toolOutput:out 5",
            "toolOutput:out 6",
            "toolOutput:out 7",
            "toolOutput:out 8",
            "muted:… 3 earlier lines · ctrl+o to expand",
        ];

        for (const call of expected) {
            assert.ok(colours.includes(call), `the box must request ${call}`);
        }

        assert.deepEqual(
            [...new Set(fgCalls.map(({ color }) => color))].sort(),
            ["dim", "muted", "success", "text", "toolOutput"],
            "the box must stay inside its palette",
        );
    });

    it("shows every line and no hint once expanded", () => {
        const output = Array.from({ length: 8 }, (_, index) => `out ${index + 1}`).join("\n") + "\n";
        const { rows } = renderRows([job({ jobOutput: output })], { expanded: true });

        assert.deepEqual(rows.slice(3, -1), [
            "     out 1",
            "     out 2",
            "     out 3",
            "     out 4",
            "     out 5",
            "     out 6",
            "     out 7",
            "     out 8",
        ]);
        assert.ok(!rows.some((row) => row.includes("earlier lines")), "an expanded job hides nothing");
    });

    it("marks the batch and each job by its own outcome", () => {
        const { rows, fgCalls, bgCalls } = renderRows([
            job({ jobId: "job-a", jobCommand: "echo a", jobOutput: "a-out\n" }),
            job({
                jobId: "job-b",
                jobCommand: "make test",
                jobStatus: "failed",
                jobExitCode: 3,
                jobError: "Background shell exited with code 3",
                jobOutput: "b-out\n",
            }),
        ]);

        assert.deepEqual(rows, [
            "",
            " ● 2 background shells · 1 failed",
            " echo a · completed · exit 0 · 4.2s",
            "     a-out",
            " make test · failed · exit 3 · 4.2s",
            "     Error: Background shell exited with code 3",
            "     b-out",
            "",
        ]);

        // One failed job turns the whole band red, but each status word keeps its own colour.
        assert.ok(bgCalls.every(({ color }) => color === "toolErrorBg"), "a failure must tint the batch");
        assert.ok(fgCalls.some(({ color, text }) => color === "error" && text === "2 background shells · 1 failed"));
        assert.ok(fgCalls.some(({ color, text }) => color === "success" && text === "completed"));
        assert.ok(fgCalls.some(({ color, text }) => color === "error" && text === "failed"));
        assert.ok(fgCalls.some(({ color, text }) => color === "error" && text === "Error: Background shell exited with code 3"));
    });

    it("reads each job's output from its own slice of the message text", () => {
        const { rows, lines } = renderRows([
            job({ jobId: "job-a", jobCommand: "echo a", jobOutput: "a 1\na 2\na 3\n" }),
            job({ jobId: "job-b", jobCommand: "echo b", jobOutput: "b 1\nb 2\nb 3\n" }),
        ]);
        const text = lines.join("\n");

        assert.deepEqual(rows.slice(3, 6), ["     a 1", "     a 2", "     a 3"]);
        assert.deepEqual(rows.slice(7, 10), ["     b 1", "     b 2", "     b 3"]);
        assert.ok(!text.includes("a 1\n     b"), "one job's tail must not bleed into the next job's rows");
    });

    it("collapses carriage-return repaints and drops terminal sequences", () => {
        const { rows } = renderRows([
            job({ jobOutput: "\x1b[31mred\x1b[0m\nprogress 10%\rprogress 100%\ntrailing\twith tab\n" }),
        ]);

        assert.deepEqual(rows.slice(3, -1), [
            "     red",
            "     progress 100%",
            "     trailing   with tab",
        ]);
    });

    it("keeps the outcome in the row when the command is longer than the transcript", () => {
        const { rows, lines } = renderRows([job({ jobCommand: "x".repeat(200) })], { outputPad: 1 });
        const row = rows.find((entry) => entry.includes("completed"))!;

        assert.ok(row.endsWith("completed · exit 0 · 4.2s"), `the outcome must survive the cut: ${row}`);
        assert.ok(row.includes("…"), `the cut command must be marked: ${row}`);
        assert.equal(visibleWidth(row.trimStart()), WIDTH - 2, "the job row fills the band exactly, padding aside");

        // Regression: the cut must not close itself with a full reset, which would drop the band's
        // background from everything after the ellipsis.
        assert.ok(!row.includes("\x1b[0m"), `the row must not reset the band: ${JSON.stringify(row)}`);

        for (const line of lines) {
            assert.equal(visibleWidth(line), WIDTH, `band row must fill the width: ${JSON.stringify(line)}`);
        }
    });

    it("returns undefined when the message carries no jobs", () => {
        const stub = createStubTheme();
        const options = { expanded: false, outputPad: 1 };
        const empty: BackgroundShellNotificationDetails = { jobs: [] };

        assert.equal(
            renderBackgroundShellNotificationBox({ content: "", details: undefined }, options, stub.theme),
            undefined,
            "a message without details must fall back to pi's own rendering",
        );
        assert.equal(
            renderBackgroundShellNotificationBox({ content: "", details: empty }, options, stub.theme),
            undefined,
            "an empty batch must fall back to pi's own rendering",
        );
    });
});

/** Where Lune Core publishes its theme renderer; Core is an optional peer, so tests publish a fake. */
const THEME_RENDERER_KEY = Symbol.for("nouvelle-lune.lune-theme-renderer.v1");

type RenderActivityArgs = [activity: any, options: { expanded: boolean }, theme: Theme];

interface FakeThemedComponent extends Component {
    renderWidths: number[];
    invalidations: number;
}

interface FakeRenderer {
    version: 1;
    renderActivity: (...args: RenderActivityArgs) => FakeThemedComponent;
    calls: RenderActivityArgs[];
    components: FakeThemedComponent[];
}

/** A renderer that records every call and returns a component whose lines name its creation order. */
function createFakeRenderer(label = "themed"): FakeRenderer {
    const renderer: FakeRenderer = {
        version: 1,
        calls: [],
        components: [],
        renderActivity: (...args) => {
            const index = renderer.components.length;
            const component: FakeThemedComponent = {
                renderWidths: [],
                invalidations: 0,
                render(width: number) {
                    component.renderWidths.push(width);
                    return [`${label}#${index}@${width}`];
                },
                invalidate() {
                    component.invalidations += 1;
                },
            };

            renderer.calls.push(args);
            renderer.components.push(component);

            return component;
        },
    };

    return renderer;
}

function publishRenderer(renderer: unknown): void {
    (globalThis as Record<symbol, unknown>)[THEME_RENDERER_KEY] = renderer;
}

function createBox(
    batch: readonly BackgroundShellNotification[],
    options: { expanded?: boolean } = {},
): { box: Component; theme: Theme } {
    const { content, details } = buildBackgroundShellNotification(batch);
    const { theme } = createStubTheme();
    const box = renderBackgroundShellNotificationBox(
        { content, details },
        { expanded: options.expanded ?? false, outputPad: 1 },
        theme,
    );

    assert.ok(box, "guard: the batch must render a box");

    return { box, theme };
}

describe("background shell notification box under Lune Core's theme", () => {
    // The renderer lives on globalThis, so a leaked value would retheme every later test.
    afterEach(() => {
        delete (globalThis as Record<symbol, unknown>)[THEME_RENDERER_KEY];
    });

    it("draws its own band when no renderer is published", () => {
        const { box } = createBox([job()]);

        const actual = box.render(WIDTH).map((line) => line.trimEnd());

        assert.equal(actual[1], " ● 1 background shell settled");
    });

    it("draws its own band when the published renderer has another version", () => {
        const renderer = { ...createFakeRenderer(), version: 2 };
        publishRenderer(renderer);
        const { box } = createBox([job()]);

        const actual = box.render(WIDTH).map((line) => line.trimEnd());

        assert.equal(actual[1], " ● 1 background shell settled");
        assert.equal(renderer.calls.length, 0, "an unknown contract version must not be called");
    });

    it("returns the themed component's lines and passes the theme through", () => {
        const renderer = createFakeRenderer();
        publishRenderer(renderer);
        const { box, theme } = createBox([job()]);

        const actual = box.render(WIDTH);

        assert.deepEqual(actual, [`themed#0@${WIDTH}`]);
        assert.equal(renderer.calls.length, 1);
        assert.equal(renderer.calls[0]![2], theme);
    });

    it("maps one job to a singular activity without a summary", () => {
        const renderer = createFakeRenderer();
        publishRenderer(renderer);
        const { box } = createBox([
            job({
                jobCommand: "npm run\n  build\t--watch",
                jobStatus: "completed",
                jobExitCode: 0,
                jobDurationMs: 4200,
                jobOutput: "line 1\nline 2\n",
            }),
        ]);

        box.render(WIDTH);

        const expected = {
            title: "background shell",
            summary: undefined,
            entries: [
                {
                    name: "bash",
                    summary: "npm run build --watch",
                    status: "done",
                    detail: "exit 0",
                    durationMs: 4200,
                    error: undefined,
                    output: "line 1\nline 2\n",
                },
            ],
        };

        assert.deepEqual(renderer.calls[0]![0], expected);
    });

    it("maps several jobs to a plural activity with one entry per job and its own output slice", () => {
        const renderer = createFakeRenderer();
        publishRenderer(renderer);
        const { box } = createBox([
            job({ jobId: "job-a", jobCommand: "echo a", jobOutput: "a-out\n" }),
            job({
                jobId: "job-b",
                jobCommand: "make test",
                jobStatus: "failed",
                jobExitCode: 3,
                jobError: "Background shell exited with code 3",
                jobOutput: "b-out\n",
                jobDurationMs: 90,
            }),
        ]);

        box.render(WIDTH);

        const expected = {
            title: "background shells",
            summary: "2 jobs",
            entries: [
                {
                    name: "bash",
                    summary: "echo a",
                    status: "done",
                    detail: "exit 0",
                    durationMs: 4200,
                    error: undefined,
                    output: "a-out\n",
                },
                {
                    name: "bash",
                    summary: "make test",
                    status: "failed",
                    detail: "exit 3",
                    durationMs: 90,
                    error: "Background shell exited with code 3",
                    output: "b-out\n",
                },
            ],
        };

        assert.deepEqual(renderer.calls[0]![0], expected);
    });

    it("maps completed to done, killed to cancelled and every other status to failed", () => {
        const renderer = createFakeRenderer();
        publishRenderer(renderer);
        const statuses = ["completed", "killed", "failed", "timeout"];
        const { box } = createBox(statuses.map((jobStatus, index) => job({ jobId: `job-${index}`, jobStatus })));

        box.render(WIDTH);

        const actual = renderer.calls[0]![0].entries.map((entry: { status: string }) => entry.status);

        assert.deepEqual(actual, ["done", "cancelled", "failed", "failed"]);
    });

    it("omits the exit detail and duration when the job has neither", () => {
        const renderer = createFakeRenderer();
        publishRenderer(renderer);
        const { box } = createBox([
            job({ jobStatus: "killed", jobExitCode: undefined, jobDurationMs: undefined }),
        ]);

        box.render(WIDTH);

        const [entry] = renderer.calls[0]![0].entries;

        assert.equal(entry.detail, undefined);
        assert.equal(entry.durationMs, undefined);
    });

    it("normalises output like the band: carriage-return redraws keep the last segment and terminal sequences go", () => {
        const renderer = createFakeRenderer();
        publishRenderer(renderer);
        const { box } = createBox([
            job({ jobOutput: "\x1b[31mred\x1b[0m\nprogress 10%\rprogress 100%\ncrlf line\r\ntrailing\twith tab\n" }),
        ]);

        box.render(WIDTH);

        const actual = renderer.calls[0]![0].entries[0].output;
        const expected = "red\nprogress 100%\ncrlf line\ntrailing   with tab\n";

        assert.equal(actual, expected);
    });

    it("calls the renderer once across repeated renders and reuses its component", () => {
        const renderer = createFakeRenderer();
        publishRenderer(renderer);
        const { box } = createBox([job()]);

        box.render(WIDTH);
        box.render(WIDTH);
        const actual = box.render(40);

        assert.equal(renderer.calls.length, 1);
        assert.deepEqual(renderer.components[0]!.renderWidths, [WIDTH, WIDTH, 40]);
        assert.deepEqual(actual, ["themed#0@40"]);
    });

    it("builds a new component when a different renderer object appears", () => {
        const first = createFakeRenderer("first");
        const second = createFakeRenderer("second");
        const { box } = createBox([job()]);

        publishRenderer(first);
        const before = box.render(WIDTH);
        publishRenderer(second);
        const after = box.render(WIDTH);
        box.render(WIDTH);

        assert.deepEqual(before, [`first#0@${WIDTH}`]);
        assert.deepEqual(after, [`second#0@${WIDTH}`]);
        assert.equal(first.calls.length, 1);
        assert.equal(second.calls.length, 1, "the second renderer is also called once, not per frame");
    });

    it("switches a box already on screen to the themed renderer and back", () => {
        const renderer = createFakeRenderer();
        const { box } = createBox([job()]);

        const plainBefore = box.render(WIDTH).map((line) => line.trimEnd());

        publishRenderer(renderer);
        const themed = box.render(WIDTH);

        delete (globalThis as Record<symbol, unknown>)[THEME_RENDERER_KEY];
        const plainAfter = box.render(WIDTH).map((line) => line.trimEnd());

        assert.equal(plainBefore[1], " ● 1 background shell settled");
        assert.deepEqual(themed, [`themed#0@${WIDTH}`]);
        assert.deepEqual(plainAfter, plainBefore, "turning the theme off restores the unchanged band");
    });

    it("forwards the expanded option", () => {
        const collapsed = createFakeRenderer();
        const expanded = createFakeRenderer();

        publishRenderer(collapsed);
        createBox([job()], { expanded: false }).box.render(WIDTH);
        publishRenderer(expanded);
        createBox([job()], { expanded: true }).box.render(WIDTH);

        assert.deepEqual(collapsed.calls[0]![1], { expanded: false });
        assert.deepEqual(expanded.calls[0]![1], { expanded: true });
    });

    it("invalidates the themed component, and is safe to call before one exists", () => {
        const renderer = createFakeRenderer();
        const { box } = createBox([job()]);

        box.invalidate();
        publishRenderer(renderer);
        box.render(WIDTH);
        box.invalidate();
        box.invalidate();

        assert.equal(renderer.components[0]!.invalidations, 2);
    });
});
