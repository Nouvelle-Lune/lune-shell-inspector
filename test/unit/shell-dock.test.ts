/**
 * Unit tests for the shell dock renderer.
 *
 * `renderShellDock`/`clearShellDock` turn the shared `ShellManager` job list into the one-line
 * widget pi shows below the editor. The tests drive the real singleton, assert the exact widget
 * key, placement and line the extension asks pi to mount, and cover the content rules of that line:
 * status counts, the latest running command, whitespace normalization and truncation. How pi then
 * composes that widget with another extension's widget is covered by
 * `test/integration/subagent-widget.test.ts`; the real TUI is observed through `test/tui`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { clearShellDock, renderShellDock } from "../../src/shell/shell-dock.ts";
import { shellManager, type ShellJobStatus } from "../../src/shell/shell-manager.ts";
import { createFakeContext, createFakeUi, type FakeExtensionUi } from "../harness.ts";

/**
 * Widget key the extension registers.
 *
 * pi keys widgets by this string, so it is part of the extension's external contract: changing it
 * changes where the dock appears relative to other extensions' widgets.
 */
const WIDGET_ID = "pi-shell-view";

/** Start one job and settle it into `status`. */
function addJob(id: string, command: string, status: ShellJobStatus = "running"): void {
    shellManager.startJob({ id, command, cwd: "/tmp" });

    switch (status) {
        case "running":
            return;
        case "completed":
            shellManager.completeJob(id, "done");
            return;
        case "failed":
            shellManager.failJob(id, "Command exited with code 1", 1);
            return;
        case "stopped":
            shellManager.stopJob(id, "Command aborted");
    }
}

/** Render the dock into a fresh fake UI and return the UI plus the last widget call. */
function render(): FakeExtensionUi {
    const ui = createFakeUi();
    renderShellDock(createFakeContext("/work", { ui }));
    return ui;
}

/** The dock line currently mounted below the editor, or undefined when the key is not mounted. */
function mountedLine(ui: FakeExtensionUi): readonly string[] | undefined {
    const content = ui.mountedWidget("belowEditor", WIDGET_ID);
    if (content === undefined) {
        return undefined;
    }
    assert.ok(Array.isArray(content), "the dock must be mounted as an array of lines");
    return content;
}

describe("shell dock", () => {
    beforeEach(() => {
        shellManager.clearAllJobs();
    });

    afterEach(() => {
        shellManager.clearAllJobs();
    });

    describe("renderShellDock", () => {
        it("does nothing without a UI", () => {
            // Contract: setWidget only makes sense in a UI session, so a print/RPC context must not be
            // asked to mount anything.
            addJob("job-1", "sleep 30");
            const ui = createFakeUi();

            renderShellDock(createFakeContext("/work", { ui, hasUI: false }));

            assert.deepEqual(ui.widgetCalls, []);
        });

        it("removes the widget when there are no jobs", () => {
            // Contract: an empty job list mounts nothing, which is also how a finished session leaves
            // the editor clean.
            const ui = render();

            assert.equal(ui.widgetCalls.length, 1);
            assert.deepEqual(ui.widgetCalls.at(0), {
                key: WIDGET_ID,
                content: undefined,
                placement: undefined,
            });
            assert.equal(ui.mountedWidget("belowEditor", WIDGET_ID), undefined);
        });

        it("mounts one line below the editor with counts and the running command", () => {
            // Contract: the dock is a single line placed below the editor, reporting the total shell
            // count, the per-status counts and the latest running command.
            addJob("job-1", "sleep 30");

            const ui = render();

            assert.deepEqual(ui.widgetCalls.at(-1), {
                key: WIDGET_ID,
                content: ["  Shells · 1 shells · 1 running · sleep 30"],
                placement: "belowEditor",
            });
            assert.deepEqual(mountedLine(ui), ["  Shells · 1 shells · 1 running · sleep 30"]);
            assert.deepEqual(ui.mountedKeys("belowEditor"), [WIDGET_ID]);
            assert.deepEqual(ui.mountedKeys("aboveEditor"), [], "the dock must not occupy the above-editor slot");
        });

        it("reports every status in running, completed, failed, stopped order and omits empty ones", () => {
            addJob("running", "sleep 30", "running");
            addJob("completed", "echo done", "completed");
            addJob("failed", "exit 1", "failed");
            addJob("stopped", "sleep 60", "stopped");
            addJob("stopped-2", "sleep 60", "stopped");

            const ui = render();

            assert.deepEqual(mountedLine(ui), ["  Shells · 5 shells · 1 running · 1 completed · 1 failed · 2 stopped · sleep 30"]);
        });

        it("omits status counts that are zero", () => {
            // Contract: a settled job list keeps only the non-zero counters, so the line stays short.
            addJob("completed", "echo done", "completed");

            const ui = render();

            assert.deepEqual(mountedLine(ui), ["  Shells · 1 shells · 1 completed"]);
            assert.equal(mountedLine(ui)?.at(0)?.includes("running"), false);
        });

        it("shows the most recently started running job, not the most recent job", () => {
            // Contract: the command segment follows the last running job in insertion order; settled
            // jobs that started later must not replace it.
            addJob("first", "sleep 1", "running");
            addJob("settled", "echo done", "completed");
            addJob("second", "sleep 2", "running");
            addJob("failed", "exit 1", "failed");

            const ui = render();

            assert.deepEqual(mountedLine(ui), ["  Shells · 4 shells · 2 running · 1 completed · 1 failed · sleep 2"]);
        });

        it("shows no command segment when nothing is running", () => {
            addJob("completed", "echo done", "completed");
            addJob("failed", "exit 1", "failed");

            const ui = render();

            assert.deepEqual(mountedLine(ui), ["  Shells · 2 shells · 1 completed · 1 failed"]);
        });

        it("normalizes the command to one line", () => {
            // Contract: a multi-line command would break the single-line widget, so every run of
            // whitespace collapses into one space and the result is trimmed.
            addJob("job-1", "  printf\t'first\\nsecond'\n  && echo   done  ");

            const ui = render();

            assert.deepEqual(mountedLine(ui), ["  Shells · 1 shells · 1 running · printf 'first\\nsecond' && echo done"]);
        });

        it("truncates a long command at 60 characters", () => {
            // Contract: the command segment is capped at 60 characters, with the last character
            // replaced by an ellipsis, so the dock cannot wrap.
            addJob("job-1", `echo ${"x".repeat(100)}`);

            const ui = render();

            const line = mountedLine(ui)?.at(0) ?? "";
            const command = line.split(" · ").at(-1) ?? "";
            assert.equal(command.length, 60, `expected a 60-character command segment, got ${command.length}`);
            assert.equal(command, `${`echo ${"x".repeat(100)}`.slice(0, 59)}…`);
            assert.ok(command.endsWith("…"), "a truncated command must end with the ellipsis");
        });

        it("keeps a command of exactly 60 characters unchanged", () => {
            // Contract: the cap is inclusive, so a command that fits is not marked as truncated.
            const command = "y".repeat(60);
            addJob("job-1", command);

            const ui = render();

            assert.deepEqual(mountedLine(ui), [`  Shells · 1 shells · 1 running · ${command}`]);
        });

        it("re-mounts the same key with updated content on every render", () => {
            // Contract: each render replaces the dock content under the same key; pi keeps one widget
            // per key, so later renders do not stack duplicate lines.
            addJob("job-1", "sleep 30", "running");
            addJob("job-2", "sleep 60", "running");
            const ui = createFakeUi();
            const ctx = createFakeContext("/work", { ui });

            renderShellDock(ctx);
            shellManager.completeJob("job-2", "done");
            renderShellDock(ctx);

            assert.equal(ui.widgetCalls.length, 2, "expected one widget call per render");
            assert.deepEqual(mountedLine(ui), ["  Shells · 2 shells · 1 running · 1 completed · sleep 30"]);
            assert.deepEqual(ui.mountedKeys("belowEditor"), [WIDGET_ID]);
        });
    });

    describe("clearShellDock", () => {
        it("removes only the shell dock widget", () => {
            addJob("job-1", "sleep 30");
            const ui = createFakeUi();
            const ctx = createFakeContext("/work", { ui });
            renderShellDock(ctx);

            clearShellDock(ctx);

            assert.equal(ui.mountedWidget("belowEditor", WIDGET_ID), undefined);
            assert.deepEqual(ui.widgetCalls.at(-1), {
                key: WIDGET_ID,
                content: undefined,
                placement: undefined,
            });
        });

        it("does nothing without a UI", () => {
            const ui = createFakeUi();

            clearShellDock(createFakeContext("/work", { ui, hasUI: false }));

            assert.deepEqual(ui.widgetCalls, []);
        });
    });
});
