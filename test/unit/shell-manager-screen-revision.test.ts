/**
 * Unit tests for `ShellManager.getScreenRevision`.
 *
 * Readers that derive something expensive from a job's screen (the inspector wraps it into pane
 * rows) skip the work while the revision is equal, so the contract is one-sided but strict: the
 * revision must differ whenever `getScreenLines` could return something different. That includes
 * content the emulator rewrote without adding a line, and a job that reuses the id of a cleared one.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { shellManager } from "../../src/shell/shell-manager.ts";
import { readJobScreen } from "../harness.ts";

function startJob(id: string): void {
    shellManager.startJob({ id, command: `cmd ${id}`, cwd: "/work", controller: new AbortController() });
}

async function writeOutput(id: string, output: string): Promise<void> {
    shellManager.appendOutput(id, output);
    await readJobScreen(id);
}

describe("shell manager screen revision", () => {
    afterEach(() => {
        shellManager.clearAllJobs();
    });

    it("changes once the emulator has parsed new output", async () => {
        startJob("a");
        const before = shellManager.getScreenRevision("a");

        await writeOutput("a", "first\n");
        const afterFirst = shellManager.getScreenRevision("a");

        await writeOutput("a", "second\n");

        assert.notEqual(afterFirst, before);
        assert.notEqual(shellManager.getScreenRevision("a"), afterFirst);
    });

    it("stays put while the screen is only read", async () => {
        startJob("a");
        await writeOutput("a", "first\n");
        const settled = shellManager.getScreenRevision("a");

        shellManager.getScreenLines("a");
        shellManager.getJob("a");

        assert.equal(shellManager.getScreenRevision("a"), settled);
    });

    it("changes when output rewrites a line without adding one", async () => {
        startJob("a");
        await writeOutput("a", "progress 10%\r");
        const before = shellManager.getScreenRevision("a");
        const linesBefore = shellManager.getScreenLines("a");

        await writeOutput("a", "progress 90%\r");
        const linesAfter = shellManager.getScreenLines("a");

        assert.equal(linesAfter.length, linesBefore.length);
        assert.notDeepEqual(linesAfter, linesBefore);
        assert.notEqual(shellManager.getScreenRevision("a"), before);
    });

    it("never repeats a revision across jobs", async () => {
        startJob("a");
        startJob("b");
        await writeOutput("a", "same\n");
        await writeOutput("b", "same\n");

        assert.notEqual(shellManager.getScreenRevision("a"), shellManager.getScreenRevision("b"));
    });

    it("gives a job that reuses a cleared id a revision no earlier screen had", async () => {
        startJob("a");
        await writeOutput("a", "old\n");
        const seen = shellManager.getScreenRevision("a");
        shellManager.settleJob("a", { type: "completed", exitCode: 0 });
        assert.equal(shellManager.clearJob("a"), true);

        startJob("a");
        const fresh = shellManager.getScreenRevision("a");
        await writeOutput("a", "new\n");

        assert.notEqual(fresh, seen);
        assert.notEqual(shellManager.getScreenRevision("a"), seen);
    });

    it("refuses an unknown job like the other screen readers", () => {
        assert.throws(() => shellManager.getScreenRevision("missing"), /Unknown shell job/);
        assert.throws(() => shellManager.getScreenLines("missing"), /Unknown shell job/);
    });
});
