/**
 * Coexistence of the shell dock with the widgets pi-subagents mounts.
 *
 * pi keeps one widget per key in two placement buckets (`setExtensionWidget`), so extensions cannot
 * overwrite each other - but they share the below-editor area, and re-setting a key removes and
 * re-inserts it. pi-subagents registers `subagent-fleet-status` and `subagent-async` there while
 * subagent runs exist; this file asserts that the shell dock survives that and stays independent:
 * it only ever touches its own key, keeps rendering while another extension's widgets are mounted,
 * and clearing it (no jobs left, session shutdown) removes nothing but itself.
 *
 * The fake UI models pi's registry, so these assertions describe what the extension asks pi to
 * mount. Whether the composed area then *looks* right is a TUI question, observed through
 * `test/tui` and the subagent scenario documented in `test/tui/README.md`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { shellDock } from "../../src/shell/shell-dock.ts";
import { shellManager } from "../../src/shell/shell-manager.ts";
import {
    createFakeUi,
    createFakeContext,
    createTempWorkDir,
    openSession,
    removeTempWorkDir,
    runBashCommand,
    type ExtensionSession,
    type FakeExtensionUi,
    type WidgetContent,
} from "../harness.ts";

/** Widget key of the shell dock. */
const SH_DOCK_KEY = "pi-shell-view";

/** Widget keys pi-subagents uses for the async job list and the inline fleet surface. */
const SUBAGENT_ASYNC_KEY = "subagent-async";
const SUBAGENT_FLEET_KEY = "subagent-fleet-status";

/** One mounted pi-subagents widget: the real ones are component factories, not line arrays. */
function subagentWidget(label: string): WidgetContent {
    return () => ({
        render: (): string[] => [`  ▸ ${label}`],
        invalidate: (): void => {},
    });
}

/** The dock line currently mounted below the editor, or undefined when it is not mounted. */
function dockLine(ui: FakeExtensionUi): readonly string[] | undefined {
    const content = ui.mountedWidget("belowEditor", SH_DOCK_KEY);
    if (content === undefined) {
        return undefined;
    }
    assert.ok(Array.isArray(content), "the dock must be mounted as an array of lines");
    return content;
}

/**
 * Text of the single dock line mounted below the editor, or undefined when none is mounted.
 *
 * The summary embeds wall-clock elapsed seconds, so tests match the line as a pattern instead of
 * pinning a value that depends on how fast the command ran.
 */
function dockText(ui: FakeExtensionUi): string | undefined {
    const content = dockLine(ui);
    assert.ok(content === undefined || content.length === 1, "the dock must stay a single line");
    return content?.[0];
}

/** Every widget key touched by the extension, i.e. every call after the test's own mounts. */
function keysTouchedSince(ui: FakeExtensionUi, index: number): Set<string> {
    return new Set(ui.widgetCalls.slice(index).map((call) => call.key));
}

describe("shell dock next to pi-subagents widgets", () => {
    beforeEach(() => {
        shellManager.clearAllJobs();
    });

    afterEach(() => {
        shellManager.clearAllJobs();
    });

    it("mounts the dock below the editor without disturbing the subagent widgets", async () => {
        const workDir = createTempWorkDir("subagent-dock");
        const session = await openSession(workDir);
        try {
            const fleetWidget = subagentWidget("subagent fleet · 1 running");
            const asyncWidget = subagentWidget("async run · probe");
            session.ui.setWidget(SUBAGENT_FLEET_KEY, fleetWidget, { placement: "belowEditor" });
            session.ui.setWidget(SUBAGENT_ASYNC_KEY, asyncWidget, { placement: "belowEditor" });
            const extensionCallBaseline = session.ui.widgetCalls.length;

            const run = await runBashCommand(session.tool, {
                command: "sleep 0.5; printf 'done\\n'",
                ctx: session.ctx,
                toolCallId: "call-with-subagent",
            });

            assert.equal(run.failed, false, `expected the command to succeed: ${run.error?.message ?? ""}`);
            assert.match(dockText(session.ui) ?? "", /^1 shell completed in \d+s · \/shell to open$/);

            assert.equal(
                session.ui.mountedWidget("belowEditor", SUBAGENT_FLEET_KEY),
                fleetWidget,
                "the fleet widget must still be the exact object pi-subagents mounted",
            );
            assert.equal(session.ui.mountedWidget("belowEditor", SUBAGENT_ASYNC_KEY), asyncWidget);
            assert.deepEqual(
                keysTouchedSince(session.ui, extensionCallBaseline),
                new Set([SH_DOCK_KEY]),
                "the dock must only ever touch its own key",
            );
        } finally {
            await session.host.emit("session_shutdown", session.ctx);
            removeTempWorkDir(workDir);
        }
    });

    it("keeps the dock rendered and updated across the whole command", async () => {
        // Contract: a command streams many snapshots, so the dock is re-mounted repeatedly. Every
        // re-mount must target the dock key only, and the subagent widgets must survive all of them.
        const workDir = createTempWorkDir("subagent-stream");
        const session = await openSession(workDir);
        try {
            const fleetWidget = subagentWidget("subagent fleet · 1 running");
            session.ui.setWidget(SUBAGENT_FLEET_KEY, fleetWidget, { placement: "belowEditor" });
            const extensionCallBaseline = session.ui.widgetCalls.length;

            const run = await runBashCommand(session.tool, {
                command: "for n in 1 2 3 4 5; do printf 'line %s\\n' \"$n\"; sleep 0.2; done",
                ctx: session.ctx,
                toolCallId: "call-stream-with-subagent",
            });

            assert.equal(run.failed, false, `expected the command to succeed: ${run.error?.message ?? ""}`);
            assert.ok(run.updates.length > 1, "expected several streamed snapshots");
            assert.ok(session.ui.widgetCalls.length > 2, "expected a re-render per mutation");
            assert.equal(
                session.ui.mountedWidget("belowEditor", SUBAGENT_FLEET_KEY),
                fleetWidget,
                "no shell update may replace the fleet widget",
            );
            assert.deepEqual(keysTouchedSince(session.ui, extensionCallBaseline), new Set([SH_DOCK_KEY]));
            assert.match(dockText(session.ui) ?? "", /^1 shell completed in \d+s · \/shell to open$/);
        } finally {
            await session.host.emit("session_shutdown", session.ctx);
            removeTempWorkDir(workDir);
        }
    });

    it("keeps the dock to one line so the shared below-editor area stays bounded", async () => {
        // Contract: pi caps an array widget at 10 lines, and below the editor that budget is shared
        // with whatever pi-subagents draws; the dock must stay a single line no matter how many jobs
        // are tracked.
        const workDir = createTempWorkDir("subagent-one-line");
        const session = await openSession(workDir);
        try {
            for (let index = 0; index < 12; index += 1) {
                shellManager.startJob({ id: `job-${index}`, command: `sleep ${index}`, cwd: workDir });
            }

            const content = session.ui.mountedWidget("belowEditor", SH_DOCK_KEY);
            assert.ok(Array.isArray(content), "the dock must be mounted as an array of lines");
            assert.equal(content.length, 1, "the dock must render exactly one line");
            assert.match(content[0] ?? "", /^12 shells · 12 running · \/shell to open$/);
        } finally {
            await session.host.emit("session_shutdown", session.ctx);
            removeTempWorkDir(workDir);
        }
    });

    it("re-inserts the dock at the end of the below-editor area on every render", async () => {
        // Contract: pi removes and re-inserts a widget key on every setWidget, so the widget that was
        // updated last is drawn last. A dock update therefore moves the shell line below any widget
        // pi-subagents mounted before it; this is pi's ordering rule, and the dock must not try to
        // work around it (for example by touching a neighbour) - the fleet line follows the same rule.
        const workDir = createTempWorkDir("subagent-order");
        const session = await openSession(workDir);
        try {
            const fleetWidget = subagentWidget("subagent fleet · 1 running");
            session.ui.setWidget(SUBAGENT_FLEET_KEY, fleetWidget, { placement: "belowEditor" });

            shellManager.startJob({ id: "job-1", command: "sleep 30", cwd: workDir });
            assert.deepEqual(session.ui.mountedKeys("belowEditor"), [SUBAGENT_FLEET_KEY, SH_DOCK_KEY]);

            session.ui.setWidget(SUBAGENT_FLEET_KEY, fleetWidget, { placement: "belowEditor" });
            assert.deepEqual(session.ui.mountedKeys("belowEditor"), [SH_DOCK_KEY, SUBAGENT_FLEET_KEY], "the fleet refresh moved it after the dock");

            shellManager.completeJob("job-1", "done");
            assert.deepEqual(
                session.ui.mountedKeys("belowEditor"),
                [SUBAGENT_FLEET_KEY, SH_DOCK_KEY],
                "the dock render must move the shell line back to the end",
            );
            assert.equal(session.ui.mountedWidget("belowEditor", SUBAGENT_FLEET_KEY), fleetWidget);
        } finally {
            await session.host.emit("session_shutdown", session.ctx);
            removeTempWorkDir(workDir);
        }
    });

    it("removes only the dock when the job list empties", async () => {
        // Contract: with no jobs the dock clears its own key; widgets another extension owns stay
        // mounted so subagent progress keeps showing.
        const workDir = createTempWorkDir("subagent-clear");
        const session = await openSession(workDir);
        try {
            const fleetWidget = subagentWidget("subagent fleet · 1 running");
            session.ui.setWidget(SUBAGENT_FLEET_KEY, fleetWidget, { placement: "belowEditor" });

            shellManager.startJob({ id: "job-1", command: "sleep 30", cwd: workDir });
            assert.ok(dockLine(session.ui));

            shellManager.clearAllJobs();

            assert.equal(dockLine(session.ui), undefined, "the dock must be gone");
            assert.equal(session.ui.mountedWidget("belowEditor", SUBAGENT_FLEET_KEY), fleetWidget);

            shellDock.render();
            assert.equal(dockLine(session.ui), undefined, "rendering an empty job list must keep the dock cleared");
            assert.equal(session.ui.mountedWidget("belowEditor", SUBAGENT_FLEET_KEY), fleetWidget);
        } finally {
            await session.host.emit("session_shutdown", session.ctx);
            removeTempWorkDir(workDir);
        }
    });

    it("removes only the dock on session shutdown", async () => {
        const workDir = createTempWorkDir("subagent-shutdown");
        const session = await openSession(workDir);
        try {
            const fleetWidget = subagentWidget("subagent fleet · 1 running");
            session.ui.setWidget(SUBAGENT_FLEET_KEY, fleetWidget, { placement: "belowEditor" });
            shellManager.startJob({ id: "job-1", command: "sleep 30", cwd: workDir });
            assert.ok(dockLine(session.ui));
            const extensionCallBaseline = session.ui.widgetCalls.length;

            await session.host.emit("session_shutdown", session.ctx);

            assert.equal(dockLine(session.ui), undefined);
            assert.equal(session.ui.mountedWidget("belowEditor", SUBAGENT_FLEET_KEY), fleetWidget);
            assert.deepEqual(keysTouchedSince(session.ui, extensionCallBaseline), new Set([SH_DOCK_KEY]));
        } finally {
            removeTempWorkDir(workDir);
        }
    });

    it("leaves every widget alone when the session has no UI", async () => {
        // Contract: the dock returns early without a UI, so a print-mode session (or an RPC context
        // that has no widget surface) cannot drop the subagent widgets.
        const ui = createFakeUi();
        const fleetWidget = subagentWidget("subagent fleet · 1 running");
        ui.setWidget(SUBAGENT_FLEET_KEY, fleetWidget, { placement: "belowEditor" });
        const ctx = createFakeContext("/work", { ui, hasUI: false });

        shellDock.setCtx(ctx);
        shellDock.render();
        shellDock.clear();

        assert.deepEqual(ui.widgetCalls.map((call) => call.key), [SUBAGENT_FLEET_KEY], "only the test's own mount may be recorded");
        assert.equal(ui.mountedWidget("belowEditor", SUBAGENT_FLEET_KEY), fleetWidget);
    });

    it("survives a subagent widget being mounted while the command runs", async () => {
        // Contract: pi-subagents mounts its widget when a subagent starts mid-command. The dock's next
        // render must keep both widgets mounted, so the shell line is never sacrificed to the subagent
        // surface (or the other way round).
        const workDir = createTempWorkDir("subagent-mid-command");
        const session = await openSession(workDir);
        try {
            const command = runBashCommand(session.tool, {
                command: "for n in 1 2 3 4; do echo x; sleep 0.25; done",
                ctx: session.ctx,
                toolCallId: "call-subagent-starts",
            });

            assert.match(dockText(session.ui) ?? "", /^1 running shell · for n in 1 2 3 4; do\.\.\. · \d+s · \/shell to open$/);

            const fleetWidget = subagentWidget("subagent fleet · 1 running");
            session.ui.setWidget(SUBAGENT_FLEET_KEY, fleetWidget, { placement: "belowEditor" });
            const extensionCallBaseline = session.ui.widgetCalls.length;

            await command;

            assert.equal(session.ui.mountedWidget("belowEditor", SUBAGENT_FLEET_KEY), fleetWidget);
            assert.match(dockText(session.ui) ?? "", /^1 shell completed in \d+s · \/shell to open$/);
            assert.deepEqual(keysTouchedSince(session.ui, extensionCallBaseline), new Set([SH_DOCK_KEY]));
        } finally {
            await session.host.emit("session_shutdown", session.ctx);
            removeTempWorkDir(workDir);
        }
    });
});
