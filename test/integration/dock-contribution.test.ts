import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    getDockRegistry,
    type DockHost,
} from "lune-dock-protocol/host";

import type { LuneDockProvider } from "lune-dock-protocol";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import luneShellInspector from "../../src/index.ts";
import { ShellDockContribution } from "../../src/shell/shell-dock-contribution.ts";
import { shellManager, type ShellJobStatus } from "../../src/shell/shell-manager.ts";
import {
    createFakeContext,
    createFakeUi,
    type CustomCall,
    type FakeExtensionUi,
} from "../harness.ts";

const WIDGET_KEY = "lune-shell-inspector";
const liveSessions: ShellSession[] = [];
const directContributions: ShellDockContribution[] = [];

interface ShellSession {
    host: ShellHost;
    ui: FakeExtensionUi;
    ctx: ExtensionContext;
    closed: boolean;
}

type ShellHandler = (event: unknown, ctx: ExtensionContext) => unknown;

interface ShellHost {
    readonly commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>;
    fire(event: string, ctx: ExtensionContext): Promise<void>;
}

/** Register the real extension entry point against the smallest API surface its lifecycle uses. */
function createShellHost(): ShellHost {
    const handlers = new Map<string, ShellHandler[]>();
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
    const api = {
        on(event: string, handler: ShellHandler) {
            const registered = handlers.get(event) ?? [];
            registered.push(handler);
            handlers.set(event, registered);
            return () => {
                const index = registered.indexOf(handler);
                if (index >= 0) registered.splice(index, 1);
            };
        },
        registerTool() {},
        registerMessageRenderer() {},
        registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
            commands.set(name, options);
        },
        appendEntry() {},
        sendMessage() {},
    } as unknown as ExtensionAPI;

    luneShellInspector(api);

    return {
        commands,
        async fire(event, ctx) {
            for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
        },
    };
}

/** Start a background-job record with the requested settled state. */
function addJob(id: string, status: ShellJobStatus): void {
    shellManager.startJob({
        id,
        command: `echo ${id}`,
        cwd: "/work",
        controller: new AbortController(),
    });
    if (status === "running") return;
    if (status === "completed") {
        shellManager.settleJob(id, { type: "completed", exitCode: 0 });
        return;
    }
    if (status === "failed") {
        shellManager.settleJob(id, { type: "failed", error: "Command exited with code 1", exitCode: 1 });
        return;
    }
    shellManager.settleJob(id, { type: "killed", error: "killed by test" });
}

/** Start the real extension lifecycle with an isolated UI scope. */
async function startSession(ui = createFakeUi(), host = createShellHost()): Promise<ShellSession> {
    const ctx = createFakeContext("/work", { ui });
    await host.fire("session_start", ctx);
    const session = { host, ui, ctx, closed: false };
    liveSessions.push(session);
    return session;
}

/** Resolve the real shell contribution registered for this session's UI. */
function registeredContribution(ui: object): LuneDockProvider {
    const contribution = getDockRegistry().getContributions(ui).find((item) => item.id === "shell-inspector");
    assert.ok(contribution, "the extension entry point must register the shell contribution for this UI");
    return contribution.provider;
}

/** Mount a dock host in one UI scope and count invalidations from that contribution. */
function attachHost(ui: object, onInvalidate: () => void = () => undefined): () => void {
    const host: DockHost = { invalidate: onInvalidate };
    return getDockRegistry().attachHost(ui, host);
}

/** Hold `ctx.ui.custom` open so a test can add failures before the inspector closes. */
function holdOverlayOpen(ui: FakeExtensionUi): { close(): void } {
    let finish: (() => void) | undefined;
    ui.custom = (factory, options) => {
        (ui.customCalls as CustomCall[]).push({ factory, options });
        return new Promise((resolve) => {
            finish = () => resolve(undefined);
        });
    };
    return {
        close() {
            assert.ok(finish, "the inspector overlay must have opened before it can close");
            finish();
        },
    };
}

describe("shell dock contribution", () => {
    beforeEach(() => {
        shellManager.clearAllJobs();
    });

    afterEach(async () => {
        for (const session of liveSessions.splice(0)) {
            if (!session.closed) {
                await session.host.fire("session_shutdown", session.ctx);
                session.closed = true;
            }
        }
        for (const contribution of directContributions.splice(0)) contribution.detach();
        shellManager.clearAllJobs();
    });

    it("aggregates running, completed, failed, and killed jobs into the shared item status", () => {
        // Contract: the shell item counts tracked jobs and prioritizes unseen failures over running and completed work.
        const contribution = new ShellDockContribution();
        directContributions.push(contribution);
        contribution.attach(createFakeContext("/work"));

        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!), "○ Shell", "idle providers remain registered");

        addJob("completed", "completed");
        assert.equal(stripTerminalSequences(contribution.getSnapshot().detail!.render(100)[0]!), "● Shell · 1 completed");

        addJob("running", "running");
        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0), "◐", "running work outranks completed work");
        assert.match(stripTerminalSequences(contribution.getSnapshot().detail!.render(100)[0]!), /1 running · 1 completed/);

        addJob("failed", "failed");
        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0), "✕", "a failed job outranks running work");
        addJob("killed", "killed");
        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0), "✕", "a killed job also requires attention");
        assert.match(stripTerminalSequences(contribution.getSnapshot().detail!.render(100)[0]!), /2 failed\/killed/);
    });

    it("publishes complete passive single-line snapshots with command and elapsed time", async () => {
        const session = await startSession();
        addJob("latest", "completed");
        const mounted = getDockRegistry().getContributions(session.ui)[0]!;
        const previous = mounted.snapshot;
        assert.match(stripTerminalSequences(previous.full!.render(200)[0]!), /latest: echo latest · \d+s/);
        for (const level of [previous.base, previous.detail!, previous.full!]) {
            for (const width of [0, 1, 8, 30, 120]) {
                const lines = level.render(width);
                assert.equal(lines.length, 1);
                assert.ok(visibleWidth(lines[0]!) <= width);
            }
        }
        addJob("second", "completed");
        assert.notStrictEqual(mounted.snapshot, previous);
        assert.match(stripTerminalSequences(previous.detail!.render(200)[0]!), /1 completed/);
        assert.match(stripTerminalSequences(mounted.snapshot.detail!.render(200)[0]!), /2 completed/);
    });

    it("keeps a newly failed job red when a successful inspector open acknowledges only its opening snapshot", async () => {
        // Contract: closing the inspector acknowledges only failures present when it opened, while completed work can then show green.
        const ui = createFakeUi();
        const ctx = createFakeContext("/work", { ui });
        const contribution = new ShellDockContribution();
        directContributions.push(contribution);
        contribution.attach(ctx);
        addJob("old-failure", "failed");
        addJob("completed", "completed");
        const overlay = holdOverlayOpen(ui);

        const opening = contribution.open(ctx);
        addJob("new-failure", "failed");
        overlay.close();
        await opening;

        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0), "✕", "the failure that arrived while the panel was open remains unseen");
        assert.equal(shellManager.clearJob("new-failure"), true);
        contribution.onManagerEvent({ type: "job-cleared", id: "new-failure" });
        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0), "●", "the original failure was acknowledged and only completed work remains");
    });

    it("keeps an only-failed item red after its failure has been opened", async () => {
        // Contract: reading a failed job clears its unseen alert, but an item containing only failures still communicates failure.
        const ui = createFakeUi();
        const ctx = createFakeContext("/work", { ui });
        const contribution = new ShellDockContribution();
        directContributions.push(contribution);
        contribution.attach(ctx);
        addJob("only-failure", "failed");
        const overlay = holdOverlayOpen(ui);

        const opening = contribution.open(ctx);
        overlay.close();
        await opening;

        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0), "✕");
        assert.match(stripTerminalSequences(contribution.getSnapshot().detail!.render(100)[0]!), /1 failed\/killed/);
    });

    it("does not acknowledge failures when opening the inspector rejects", async () => {
        // Contract: a failed panel launch did not expose the failed-job snapshot, so the alert must stay unseen.
        const ui = createFakeUi();
        ui.custom = () => Promise.reject(new Error("overlay failed"));
        const ctx = createFakeContext("/work", { ui });
        const contribution = new ShellDockContribution();
        directContributions.push(contribution);
        contribution.attach(ctx);
        addJob("failed", "failed");

        await assert.rejects(contribution.open(ctx), /overlay failed/);
        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0), "✕");
    });

    it("forgets acknowledged failure IDs when the manager is cleared", async () => {
        // Contract: clearing tracked jobs resets the acknowledgement set, so a later job reusing an ID is reported as a new failure.
        const ui = createFakeUi();
        const ctx = createFakeContext("/work", { ui });
        const contribution = new ShellDockContribution();
        directContributions.push(contribution);
        contribution.attach(ctx);
        addJob("reused-id", "failed");
        addJob("completed", "completed");
        const overlay = holdOverlayOpen(ui);

        const opening = contribution.open(ctx);
        overlay.close();
        await opening;
        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0), "●", "the viewed failure is acknowledged beside completed history");

        shellManager.clearAllJobs();
        contribution.onManagerEvent({ type: "jobs-cleared" });
        addJob("reused-id", "failed");

        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0), "✕", "a failure after the reset is unseen even when its ID was acknowledged before");
    });

    it("returns from busy to healthy when the last running job completes beside completed history", () => {
        // Contract: running work keeps the aggregate busy until it settles, then completed history is healthy.
        const contribution = new ShellDockContribution();
        directContributions.push(contribution);
        contribution.attach(createFakeContext("/work"));
        addJob("completed", "completed");
        addJob("running", "running");

        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0), "◐");
        assert.equal(shellManager.settleJob("running", { type: "completed", exitCode: 0 }), true);
        assert.equal(stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0), "●");
    });

    it("keeps a host scoped to another UI from hiding this session's fallback and restores the fallback when detached", async () => {
        // Contract: only a host attached to the contributor's UI scope may take over its widget, and detaching that host restores the standalone widget.
        const session = await startSession();
        const otherUi = createFakeUi();
        const before = session.ui.widgetCalls.length;
        addJob("visible", "completed");
        const otherHostRelease = attachHost(otherUi);

        assert.ok(session.ui.mountedWidget("belowEditor", WIDGET_KEY), "a host in another UI cannot claim this contribution");
        assert.equal(getDockRegistry().getContributions(otherUi).length, 0);
        assert.equal(getDockRegistry().getContributions(session.ui).length, 1);

        const hostRelease = attachHost(session.ui);
        assert.equal(session.ui.mountedWidget("belowEditor", WIDGET_KEY), undefined, "the scoped host owns the compact representation");
        hostRelease();
        assert.ok(session.ui.mountedWidget("belowEditor", WIDGET_KEY), "host removal restores the plugin's original widget");
        assert.ok(session.ui.widgetCalls.length > before);

        otherHostRelease();
    });

    it("retires old registrations across repeated starts, reload, and shutdown without stale UI writes", async () => {
        // Contract: each session start owns one manager listener and one UI registration, and retired contexts receive no later writes.
        const first = await startSession();
        addJob("before-restart", "completed");
        const firstCallsAtRestart = first.ui.widgetCalls.length;
        const secondUi = createFakeUi();
        const secondCtx = createFakeContext("/work", { ui: secondUi });

        await first.host.fire("session_start", secondCtx);
        first.ctx = secondCtx;
        assert.equal(getDockRegistry().getContributions(first.ui).length, 0, "the previous UI registration is released");
        assert.equal(getDockRegistry().getContributions(secondUi).length, 1, "the replacement session registers exactly once");
        const firstCallsAfterRestart = first.ui.widgetCalls.length;

        addJob("after-restart", "completed");
        assert.equal(first.ui.widgetCalls.length, firstCallsAfterRestart, "the old UI receives no job event");
        assert.ok(secondUi.widgetCalls.length > 0, "the active UI receives the job event");

        await first.host.fire("session_shutdown", secondCtx);
        first.closed = true;
        assert.equal(getDockRegistry().getContributions(secondUi).length, 0, "shutdown releases the active registration");
        const callsAfterShutdown = secondUi.widgetCalls.length;

        const reloaded = await startSession(secondUi);
        assert.equal(getDockRegistry().getContributions(secondUi).length, 1, "a reloaded extension owns one fresh registration");
        const callsBeforeReloadedJob = secondUi.widgetCalls.length;
        addJob("after-reload", "completed");
        assert.equal(secondUi.widgetCalls.length, callsBeforeReloadedJob + 2, "the reloaded listener renders the start and settle events once each");
        assert.ok(secondUi.widgetCalls.length > callsAfterShutdown);
        assert.equal(first.ui.widgetCalls.length, firstCallsAtRestart, "the retired UI remains untouched after reload");

        await reloaded.host.fire("session_shutdown", reloaded.ctx);
        reloaded.closed = true;
    });
});
