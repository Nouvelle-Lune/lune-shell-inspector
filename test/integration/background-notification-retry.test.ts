import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, it, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { shellManager } from "../../src/shell/shell-manager.ts";
import { registerBackgroundShellNotifications } from "../../src/shell/shell-notification.ts";
import { createFakeContext, createFakeUi, type SendMessageCall } from "../harness.ts";

function setup(t: TestContext, send: (call: SendMessageCall) => void | Promise<void>) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls: SendMessageCall[] = [];
    const ui = createFakeUi();
    const pi = {
        sendMessage(message: SendMessageCall["message"], options: SendMessageCall["options"]) {
            const call = { message, options };
            calls.push(call);
            return send(call);
        },
    } as unknown as ExtensionAPI;
    const unsubscribe = registerBackgroundShellNotifications(pi, createFakeContext("/work", { ui }));
    t.after(() => {
        unsubscribe();
        shellManager.clearAllJobs();
    });
    return { calls, ui, unsubscribe };
}

function complete(id: string): void {
    shellManager.startJob({ id, command: `echo ${id}`, cwd: "/work", controller: new AbortController() });
    shellManager.appendOutput(id, `${id}-output\n`);
    assert.equal(shellManager.settleJob(id, { type: "completed", exitCode: 0 }), true);
}

function ids(call: SendMessageCall): string[] {
    return (call.message.details as { jobs: Array<{ shellJobId: string }> }).jobs.map((job) => job.shellJobId);
}

async function tick(t: TestContext, ms: number): Promise<void> {
    t.mock.timers.tick(ms);
    // Await async flush settlement, including rejection handling and rescheduling, without wall-clock sleeps.
    await setImmediate();
}

describe("background notification batching and finite retry", () => {
    beforeEach(() => shellManager.clearAllJobs());

    for (const asynchronous of [false, true]) {
        it(`contains ${asynchronous ? "rejected promises" : "synchronous throws"}, retries twice, and resumes after permanent failure`, async (t) => {
            let failing = true;
            const { calls, ui } = setup(t, () => {
                if (!failing) return;
                if (asynchronous) return Promise.reject(new Error("send failed"));
                throw new Error("send failed");
            });
            complete("failed");
            for (let attempt = 1; attempt <= 3; attempt++) {
                await tick(t, 300);
                assert.equal(calls.length, attempt, "one attempt per scheduling window, not recursive retry");
                assert.deepEqual(ids(calls.at(-1)!), ["failed"]);
                assert.equal(shellManager.getJob("failed")?.status, "completed");
            }
            assert.equal(ui.notifyCalls.length, 3);
            assert.ok(ui.notifyCalls.every((call) => call.type === "error" && call.message.includes("send failed")));
            assert.match(ui.notifyCalls[0]!.message, /Requeued/);
            assert.match(ui.notifyCalls[2]!.message, /Permanently failed.*failed.*Dropped/);
            await tick(t, 10_000);
            assert.equal(calls.length, 3, "the retry budget is finite");
            failing = false;
            complete("later");
            await tick(t, 300);
            assert.equal(calls.length, 4, "flushing state recovers after failure");
            assert.deepEqual(ids(calls[3]!), ["later"]);
            await tick(t, 10_000);
            assert.equal(calls.length, 4, "delivered notifications are not retried");
        });
    }

    it("requeues the failed batch with new arrivals, preserving per-item retry budgets", async (t) => {
        let reject!: (reason: Error) => void;
        const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
        const { calls, ui } = setup(t, () => calls.length === 1 ? pending : Promise.reject(new Error("unavailable")));
        complete("older");
        await tick(t, 300);
        complete("newer");
        reject(new Error("first failed"));
        await setImmediate();
        assert.equal(calls.length, 1, "requeue must not synchronously resend");
        await tick(t, 300);
        assert.deepEqual(ids(calls[1]!), ["older", "newer"]);
        await tick(t, 300);
        assert.deepEqual(ids(calls[2]!), ["older", "newer"]);
        assert.ok(ui.notifyCalls.some((call) => /Permanently failed.*\[older\]/.test(call.message)));
        await tick(t, 300);
        assert.deepEqual(ids(calls[3]!), ["newer"], "a fresh item retains its own two retries");
        await tick(t, 10_000);
        assert.equal(calls.length, 4);
    });

    it("delivers requeued and fresh notifications together after a transient failure", async (t) => {
        const { calls, ui } = setup(t, () => {
            if (calls.length === 1) throw new Error("transient failure");
        });
        complete("retry");
        await tick(t, 300);
        complete("fresh");
        await tick(t, 300);
        assert.equal(calls.length, 2);
        assert.deepEqual(ids(calls[1]!), ["retry", "fresh"]);
        assert.equal(ui.notifyCalls.length, 1);
        await tick(t, 10_000);
        assert.equal(calls.length, 2);
    });

    it("keeps arrivals during a successful flush in the next batch", async (t) => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const { calls } = setup(t, () => calls.length === 1 ? pending : undefined);
        complete("first");
        await tick(t, 300);
        complete("second");
        await tick(t, 1000);
        assert.equal(calls.length, 1);
        release();
        await setImmediate();
        await tick(t, 300);
        assert.equal(calls.length, 2);
        assert.deepEqual(ids(calls[1]!), ["second"]);
    });

    it("debounces bursts and sends their complete metadata/output once", async (t) => {
        const { calls } = setup(t, () => {});
        complete("a");
        await tick(t, 200);
        complete("b");
        await tick(t, 299);
        assert.equal(calls.length, 0);
        await tick(t, 1);
        assert.equal(calls.length, 1);
        assert.deepEqual(ids(calls[0]!), ["a", "b"]);
        assert.match(String(calls[0]!.message.content), /a-output/);
        assert.match(String(calls[0]!.message.content), /b-output/);
        await tick(t, 1000);
        assert.equal(calls.length, 1);
    });

    it("caps continuous debounce at MAX_DELAY_MS", async (t) => {
        const { calls } = setup(t, () => {});
        complete("a");
        for (const id of ["b", "c", "d", "e"]) {
            await tick(t, 200);
            complete(id);
        }
        await tick(t, 199);
        assert.equal(calls.length, 0);
        await tick(t, 1);
        assert.equal(calls.length, 1);
        assert.deepEqual(ids(calls[0]!), ["a", "b", "c", "d", "e"]);
    });

    it("flushes at MAX_BUFFER_SIZE and contains errors from that fire-and-forget path", async (t) => {
        const { calls } = setup(t, () => { throw new Error("size-trigger failure"); });
        for (let n = 0; n < 10; n++) complete(`size-${n}`);
        assert.equal(calls.length, 1, "size threshold bypasses debounce");
        await setImmediate();
        assert.equal(calls.length, 1, "failed size-triggered batches wait for the normal scheduler");
        await tick(t, 300);
        await tick(t, 300);
        await tick(t, 10_000);
        assert.equal(calls.length, 3);
        assert.equal(ids(calls[2]!).length, 10);
    });

    it("contains failures triggered by the maximum-delay timer", async (t) => {
        const { calls, ui } = setup(t, () => Promise.reject(new Error("max-delay failure")));
        complete("max-0");
        for (let n = 1; n < 5; n++) {
            await tick(t, 200);
            complete(`max-${n}`);
        }
        await tick(t, 200);
        assert.equal(calls.length, 1);
        assert.equal(ui.notifyCalls.length, 1);
        await tick(t, 300);
        await tick(t, 300);
        await tick(t, 10_000);
        assert.equal(calls.length, 3);
    });

    it("dispose cancels retries and ignores new messages", async (t) => {
        const { calls, unsubscribe } = setup(t, () => { throw new Error("failed before dispose"); });
        complete("cancel");
        await tick(t, 300);
        unsubscribe();
        complete("ignored");
        await tick(t, 10_000);
        assert.equal(calls.length, 1);
    });

    it("does not resurrect an in-flight failed batch after disposal", async (t) => {
        let reject!: (reason: Error) => void;
        const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
        const { calls, ui, unsubscribe } = setup(t, () => pending);
        complete("in-flight");
        await tick(t, 300);
        unsubscribe();
        reject(new Error("disposed failure"));
        await setImmediate();
        await tick(t, 10_000);
        assert.equal(calls.length, 1);
        assert.match(ui.notifyCalls[0]!.message, /Dropped/);
    });

    it("records failures on stderr when no UI is available", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const fallback = t.mock.method(console, "error", () => {});
        const pi = { sendMessage() { return Promise.reject(new Error("headless failure")); } } as unknown as ExtensionAPI;
        const unsubscribe = registerBackgroundShellNotifications(pi);
        t.after(() => { unsubscribe(); shellManager.clearAllJobs(); });
        complete("headless");
        await tick(t, 300);
        await tick(t, 300);
        await tick(t, 300);
        assert.equal(fallback.mock.callCount(), 3);
        assert.match(String(fallback.mock.calls[2]!.arguments[0]), /Permanently failed.*headless.*Dropped/);
    });

    it("contains a broken diagnostic fallback as well as the transport failure", async (t) => {
        let failing = true;
        const { calls, ui } = setup(t, () => {
            if (failing) throw new Error("send failed");
        });
        t.mock.method(ui, "notify", () => { throw new Error("stale UI"); });
        t.mock.method(console, "error", () => { throw new Error("broken fallback"); });
        complete("broken-diagnostics");
        await tick(t, 300);
        await tick(t, 300);
        await tick(t, 300);
        await tick(t, 10_000);
        assert.equal(calls.length, 3);
        failing = false;
        complete("recovered");
        await tick(t, 300);
        assert.deepEqual(ids(calls[3]!), ["recovered"]);
    });

    it("falls back only when the UI diagnostic sink is unusable, without leaking its exception", async (t) => {
        const { calls, ui } = setup(t, () => { throw new Error("send failed"); });
        t.mock.method(ui, "notify", () => { throw new Error("stale UI"); });
        const fallback = t.mock.method(console, "error", () => {});
        complete("broken-ui");
        await tick(t, 300);
        await tick(t, 300);
        await tick(t, 300);
        await tick(t, 10_000);
        assert.equal(calls.length, 3);
        assert.equal(fallback.mock.callCount(), 3);
        assert.match(String(fallback.mock.calls[2]!.arguments[0]), /Permanently failed/);
    });
});
