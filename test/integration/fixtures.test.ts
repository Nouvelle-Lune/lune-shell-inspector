/**
 * Long-running fixture contract of the registered `bash` tool.
 *
 * Every fixture is a real script that keeps running for a few seconds and streams output while it
 * runs, so one foreground delegation pass (the default mode) exercises the whole chain: the built-in
 * tool spawning the process, its throttled `onUpdate` snapshots, the settled result (or failure) and
 * the truncation details for output that exceeds pi's display limits. The same fixtures also drive
 * the background path, which streams into a shell job instead - see
 * `test/integration/background-bash.test.ts`. The expectations live next to the scripts in
 * `test/fixtures/long-running-scripts.ts`.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import { LONG_RUNNING_FIXTURES } from "../fixtures/long-running-scripts.ts";
import {
    createTempWorkDir,
    openSession,
    removeTempWorkDir,
    reportedText,
    requireError,
    requireResult,
    resultText,
    runBashCommand,
    type BashRun,
    type ExtensionSession,
} from "../harness.ts";

/** Number of non-empty lines in a block of output text, treating carriage returns as line breaks. */
function lineCount(text: string): number {
    return text.split(/\r\n|\r|\n/).filter((line) => line.length > 0).length;
}

/**
 * Lines the call reported the way pi reports them: the complete, untruncated line count once the
 * built-in truncation kicked in, otherwise the lines of the reported text.
 */
function reportedLineCount(run: BashRun): number {
    const truncation = run.result?.details?.truncation;
    if (truncation?.truncated === true) {
        return truncation.totalLines;
    }
    return lineCount(reportedText(run));
}

describe("lune-shell-inspector long-running fixtures", () => {
    let workDir: string;
    let session: ExtensionSession;

    before(async () => {
        workDir = createTempWorkDir("fixtures");
        session = await openSession(workDir);
    });

    after(async () => {
        await session.host.emit("session_shutdown", session.ctx);
        removeTempWorkDir(workDir);
    });

    for (const fixture of LONG_RUNNING_FIXTURES) {
        const { expectations } = fixture;

        describe(`fixture ${fixture.id}`, () => {
            let run: BashRun;

            before(async () => {
                run = await runBashCommand(session.tool, {
                    command: fixture.command,
                    ctx: session.ctx,
                    toolCallId: `call-${fixture.id}`,
                });
            });

            it("executes the real fixture command over the expected wall-clock window", () => {
                // Contract: the built-in tool really runs the fixture and streams its output, so the
                // call stays alive for at least minDurationMs and settles within maxDurationMs.
                assert.ok(
                    run.durationMs >= expectations.minDurationMs,
                    `fixture must keep running for at least ${expectations.minDurationMs}ms, took ${run.durationMs}ms`,
                );
                assert.ok(
                    run.durationMs <= expectations.maxDurationMs,
                    `fixture must settle within ${expectations.maxDurationMs}ms, took ${run.durationMs}ms`,
                );
            });

            it("forwards cumulative onUpdate snapshots ending with the reported output", () => {
                // Contract: the first snapshot is empty, later snapshots are cumulative and never
                // shrink, and the last snapshot is a prefix of the text the call finally reports.
                assert.ok(run.updates.length >= 2, `expected the initial empty update plus a content update, got ${run.updates.length}`);

                const first = run.updates.at(0);
                assert.ok(first, "expected the initial empty update");
                assert.deepEqual(first.content, [], "the first snapshot must be empty");
                assert.equal(first.details, undefined, "the first snapshot must carry no details");

                const snapshots = run.updates.slice(1).map((update) => resultText(update));
                assert.ok(snapshots.length > 0, "expected at least one content snapshot");

                let previous = "";
                for (const [index, snapshot] of snapshots.entries()) {
                    assert.ok(snapshot.length > 0, `snapshot ${index + 1} must carry output`);
                    assert.ok(snapshot.length >= previous.length, `snapshot ${index + 1} shrank: ${snapshot.length} < ${previous.length}`);
                    previous = snapshot;
                }

                const lastSnapshot = snapshots.at(-1) ?? "";
                assert.ok(reportedText(run).startsWith(lastSnapshot), "the reported text must extend the last streamed snapshot");
            });

            it("reports at least the output line count the fixture expectations require", () => {
                // Contract: the fixture really produced its output, so the reported line count
                // (complete count for truncated output) reaches expectations.minLines.
                const lines = reportedLineCount(run);
                assert.ok(lines >= expectations.minLines, `expected at least ${expectations.minLines} reported lines, got ${lines}`);
            });

            if (expectations.fails) {
                it("propagates the built-in failure instead of swallowing it", () => {
                    // Contract: a non-zero exit makes the built-in tool throw and the extension lets
                    // that error through, so no result is returned and the message keeps the built-in
                    // status line.
                    const error = requireError(run);
                    for (const needle of expectations.errorIncludes) {
                        assert.ok(
                            error.message.includes(needle),
                            `error message must contain ${JSON.stringify(needle)}, got: ${JSON.stringify(error.message)}`,
                        );
                    }

                    const exitCode = expectations.exitCode;
                    assert.ok(exitCode !== undefined, "the failing fixture must declare an exit code");
                    assert.ok(
                        error.message.includes(`Command exited with code ${exitCode}`),
                        `error message must report the exit code ${exitCode}, got ${JSON.stringify(error.message)}`,
                    );
                });
            } else {
                it("returns the output text the fixture produced", () => {
                    // Contract: the result body is the built-in output text, so it contains every
                    // marker the fixture expectations list.
                    const output = resultText(requireResult(run));
                    for (const needle of expectations.outputIncludes) {
                        assert.ok(output.includes(needle), `output must contain ${JSON.stringify(needle)}`);
                    }
                });
            }

            if (expectations.truncated) {
                it("forwards truncation details and keeps the complete output on disk", () => {
                    // Contract: once the built-in limits are crossed, details.truncation reports the
                    // truncation with the real totals and details.fullOutputPath points at the complete
                    // output file.
                    const details = requireResult(run).details;
                    assert.equal(details?.truncation?.truncated, true, "the truncated result must say so in details");
                    assert.ok(
                        (details?.truncation?.totalLines ?? 0) >= 3000,
                        `expected the complete line count, got ${details?.truncation?.totalLines}`,
                    );

                    const fullOutputPath = details?.fullOutputPath;
                    assert.ok(fullOutputPath, "expected details.fullOutputPath on a truncated result");
                    assert.ok(existsSync(fullOutputPath), `expected the full output file at ${fullOutputPath}`);
                    assert.ok(statSync(fullOutputPath).size > 50 * 1024, "the persisted output must exceed the 50KB display limit");

                    const persisted = readFileSync(fullOutputPath, "utf8");
                    for (const needle of expectations.fullOutputIncludes) {
                        assert.ok(persisted.includes(needle), `persisted output must contain ${JSON.stringify(needle)}`);
                    }
                });

                it("reports only the tail of the output and points at the complete file", () => {
                    // Contract: the truncated body keeps the built-in footer with the retained line
                    // range and the full output path, while the head that was dropped stays gone.
                    const result = requireResult(run);
                    const output = resultText(result);
                    const details = result.details;

                    assert.match(output, /\[Showing lines \d+-\d+ of \d+[^\]]*\]/, "the built-in truncation footer must be kept");
                    assert.ok(
                        output.includes(`Full output: ${details?.fullOutputPath ?? ""}`),
                        "the footer must point at details.fullOutputPath",
                    );

                    for (const needle of expectations.fullOutputIncludes) {
                        assert.ok(output.includes(needle), `the reported text must keep the tail of the output: ${JSON.stringify(needle)}`);
                    }

                    const persistedFirstLine = readFileSync(details?.fullOutputPath ?? "", "utf8").split("\n").at(0) ?? "";
                    assert.ok(persistedFirstLine.length > 0, "the persisted output must not be empty");
                    assert.equal(output.includes(persistedFirstLine), false, "the dropped head must not be reported");
                });

                it("marks the streamed snapshots as truncated once the limits are crossed", () => {
                    // Contract: the built-in tool emits its truncation details on the streamed onUpdate
                    // snapshots too, so the caller sees them before the call settles.
                    const truncatedUpdates = run.updates.filter((update) => update.details?.truncation?.truncated === true);
                    assert.ok(truncatedUpdates.length > 0, "expected at least one streamed snapshot to report truncation");
                });
            }
        });
    }
});
