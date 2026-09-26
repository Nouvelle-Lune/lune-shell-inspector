/**
 * Unit tests for the shell dock and its summary line.
 *
 * `ShellDock` turns the shared `ShellManager` job list into the one-line widget pi shows below the
 * editor, and its private `shellDockSummary` decides what that line says for every combination of
 * job states: one running shell (command, elapsed seconds, refresh hint), one completed shell (its
 * runtime) or the per-status count list of a mixed job list. Every segment is requested in its own
 * status colour - accent while running, success when completed, error for failed and killed - and
 * the ` · ` separators plus the `/shell to open` hint stay dim, so the dock never reads as one
 * uniformly coloured block. The tests drive the real `shellManager`
 * singleton through a fake UI that records every `setWidget` and `theme.fg` call, so they assert
 * exactly what the extension asks pi to mount. How pi composes that widget with another extension's
 * widget is covered by `test/integration/subagent-widget.test.ts`; the real TUI is observed through
 * `test/tui`, where the `shelldocksum` scenario shows the same states by hand.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { ShellDock } from "../../src/shell/shell-dock.ts";
import {
  shellManager,
  type ShellJobStatus,
} from "../../src/shell/shell-manager.ts";
import {
  createFakeContext,
  createFakeUi,
  type FakeExtensionUi,
} from "../harness.ts";

/**
 * Widget key the extension registers.
 *
 * pi keys widgets by this string, so it is part of the extension's external contract: changing it
 * changes where the dock appears relative to other extensions' widgets.
 */
const WIDGET_KEY = "lune-shell-inspector";

/** Start one job and settle it into `status`. */
function addJob(
  id: string,
  command: string,
  status: ShellJobStatus = "running",
): void {
  shellManager.startJob({
    id,
    command,
    cwd: "/work",
    controller: new AbortController(),
  });

  switch (status) {
    case "running":
      return;
    case "completed":
      shellManager.settleJob(id, { type: "completed", exitCode: 0 });
      return;
    case "failed":
      shellManager.settleJob(id, {
        type: "failed",
        error: "Command exited with code 1",
        exitCode: 1,
      });
      return;
    case "killed":
      shellManager.settleJob(id, { type: "killed", error: "timeout:1" });
  }
}

/**
 * Move a job's timestamps into the past.
 *
 * The summary reads wall-clock elapsed seconds, so pinning `startedAt`/`finishedAt` relative to
 * `Date.now()` is what makes the rendered "Ns" deterministic without mocking the clock.
 */
function setJobTimes(
  id: string,
  startedAgoMs: number,
  finishedAgoMs?: number,
): void {
  const job = shellManager.getJob(id);
  assert.ok(job, `expected job ${id} to exist`);

  const mutable = job as { startedAt: number; finishedAt?: number };
  const now = Date.now();
  mutable.startedAt = now - startedAgoMs;
  if (finishedAgoMs !== undefined) {
    mutable.finishedAt = now - finishedAgoMs;
  }
}

/** Terminal columns the dock allows the command segment before the ellipsis. */
const COMMAND_COLUMN_BUDGET = 20;

/** Truncation marker the dock appends after the column budget. */
const ELLIPSIS = "…";

/** The command segment of the single-running-shell dock line. */
function commandSegment(line: string): string {
  const match = /^1 running shell · (.*) · \d+s · \/shell to open$/.exec(line);
  assert.ok(match, `not the single-running-shell summary: ${line}`);
  return match[1]!;
}

/** True when `text` holds a UTF-16 surrogate code unit without its partner. */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    text,
  );
}

describe("shell dock", () => {
  let dock: ShellDock;
  let ui: FakeExtensionUi;
  let ctx: ExtensionContext;

  beforeEach(() => {
    shellManager.clearAllJobs();
    dock = new ShellDock();
    ui = createFakeUi();
    ctx = createFakeContext("/work", { ui });
  });

  afterEach(() => {
    shellManager.clearAllJobs();
    // clear() also stops the refresh interval a running job started, so tests cannot leak a
    // timer into the next one.
    dock.clear();
  });

  /** Mount or refresh the dock through this test's context. */
  function render(): void {
    dock.setCtx(ctx);
    dock.render();
  }

  /** The dock line currently mounted below the editor. */
  function line(): string {
    const content = ui.mountedWidget("belowEditor", WIDGET_KEY);
    assert.ok(
      Array.isArray(content),
      "the dock must be mounted as an array of lines",
    );
    assert.equal(content.length, 1, "the dock must stay a single line");
    return content[0]!;
  }

  describe("render", () => {
    it("does nothing before a context is set", () => {
      addJob("job-1", "sleep 30");

      dock.render();

      assert.deepEqual(ui.widgetCalls, []);
    });

    it("does nothing without an interactive UI", () => {
      // Contract: a print/RPC session has no widget surface, so the dock must not touch it.
      addJob("job-1", "sleep 30");
      dock.setCtx(createFakeContext("/work", { ui, hasUI: false }));

      dock.render();
      dock.clear();

      assert.deepEqual(ui.widgetCalls, []);
    });

    it("removes the widget when there is no job", () => {
      // Contract: an empty job list mounts nothing, which lets pi drop the row entirely.
      render();

      assert.deepEqual(ui.widgetCalls, [
        { key: WIDGET_KEY, content: undefined, placement: undefined },
      ]);
      assert.equal(ui.mountedWidget("belowEditor", WIDGET_KEY), undefined);
    });

    it("mounts the single running shell below the editor", () => {
      // Contract: with exactly one running shell the line carries the command, the elapsed
      // seconds and the inspection hint, under the dock's own widget key.
      addJob("job-1", "sleep 30");
      setJobTimes("job-1", 400);

      render();

      assert.deepEqual(ui.widgetCalls.at(-1), {
        key: WIDGET_KEY,
        content: ["1 running shell · sleep 30 · 0s · /shell to open"],
        placement: "belowEditor",
      });
      assert.equal(line(), "1 running shell · sleep 30 · 0s · /shell to open");
      assert.deepEqual(ui.mountedKeys("belowEditor"), [WIDGET_KEY]);
      assert.deepEqual(
        ui.mountedKeys("aboveEditor"),
        [],
        "the dock must not occupy the above-editor slot",
      );
    });

    it("shows the elapsed seconds of the single running shell", () => {
      addJob("job-1", "sleep 30");
      setJobTimes("job-1", 12_500);

      render();

      assert.equal(line(), "1 running shell · sleep 30 · 12s · /shell to open");
    });

    it("truncates the command of the single running shell to the 20-column budget", () => {
      // Contract: the command segment is capped at the 20-column terminal budget including the
      // ellipsis, so one long command cannot push the dock line past the editor width.
      const command = `echo ${"x".repeat(40)}`;
      addJob("job-1", command);
      setJobTimes("job-1", 100);

      render();

      const segment = stripTerminalSequences(commandSegment(line()));
      assert.ok(
        visibleWidth(segment) <= COMMAND_COLUMN_BUDGET,
        `the command must fit ${COMMAND_COLUMN_BUDGET} columns: ${JSON.stringify(segment)}`,
      );
      assert.ok(
        segment.endsWith(ELLIPSIS),
        "an over-budget command must be marked as truncated",
      );
      assert.notEqual(segment, command, "the command must actually be shortened");
    });

    it("keeps a command of exactly 20 characters unchanged", () => {
      // Contract: the cap is inclusive, so a command that fits is not marked as truncated.
      const command = "y".repeat(20);
      addJob("job-1", command);
      setJobTimes("job-1", 100);

      render();

      assert.equal(
        line(),
        `1 running shell · ${command} · 0s · /shell to open`,
      );
    });

    it("truncates a CJK command by terminal columns, not by string length", () => {
      // Desired contract: the 20-column cap is a terminal-display budget. The command below is
      // 16 code units but 32 columns, so a length-based slice() never truncates it.
      const command = "运行测试脚本并输出结果并继续运行";
      assert.ok(
        command.length <= COMMAND_COLUMN_BUDGET,
        "guard: the code-unit length fits the budget",
      );
      assert.ok(
        visibleWidth(command) > COMMAND_COLUMN_BUDGET,
        "guard: the display width does not",
      );
      addJob("job-1", command);
      setJobTimes("job-1", 100);

      render();

      const segment = stripTerminalSequences(commandSegment(line()));
      assert.ok(
        visibleWidth(segment) <= COMMAND_COLUMN_BUDGET,
        `the command must fit ${COMMAND_COLUMN_BUDGET} columns: ${JSON.stringify(segment)}`,
      );
      assert.ok(
        segment.endsWith(ELLIPSIS),
        "an over-budget command must be marked as truncated",
      );
      assert.equal(hasLoneSurrogate(segment), false);
    });

    it("truncates an emoji command without splitting a surrogate pair", () => {
      // Desired contract: 19 ASCII code units plus an emoji cross the budget at code-unit 20,
      // which is exactly between the emoji's two surrogate halves.
      const command = `${"a".repeat(19)}🚀 tail`;
      addJob("job-1", command);
      setJobTimes("job-1", 100);

      render();

      const segment = stripTerminalSequences(commandSegment(line()));
      assert.equal(
        hasLoneSurrogate(segment),
        false,
        `a truncated command must stay well-formed: ${JSON.stringify(segment)}`,
      );
      assert.ok(
        visibleWidth(segment) <= COMMAND_COLUMN_BUDGET,
        `the command must fit ${COMMAND_COLUMN_BUDGET} columns: ${JSON.stringify(segment)}`,
      );
      assert.ok(
        segment.endsWith(ELLIPSIS),
        "an over-budget command must be marked as truncated",
      );
    });

    it("keeps the unbroken emoji example within the column budget", () => {
      // The example from the design discussion: it is long in code units, but the budget must
      // still be measured in columns and the ellipsis must be placed after the truncated text.
      const command = "🚀 build release artifacts 🔧";
      addJob("job-1", command);
      setJobTimes("job-1", 100);

      render();

      const segment = stripTerminalSequences(commandSegment(line()));
      assert.equal(hasLoneSurrogate(segment), false);
      assert.ok(
        visibleWidth(segment) <= COMMAND_COLUMN_BUDGET,
        `the command must fit ${COMMAND_COLUMN_BUDGET} columns: ${JSON.stringify(segment)}`,
      );
    });

    it("keeps a command carrying ANSI bytes within the visible-column budget", () => {
      // Defensive contract: an escape sequence is zero-width, so it must not consume the
      // terminal budget or push the visible command past it.
      const command = `\x1b[31mecho ${"x".repeat(40)}\x1b[0m`;
      addJob("job-1", command);
      setJobTimes("job-1", 100);

      render();

      const segment = stripTerminalSequences(commandSegment(line()));
      assert.ok(
        visibleWidth(segment) <= COMMAND_COLUMN_BUDGET,
        `the visible command must fit ${COMMAND_COLUMN_BUDGET} columns: ${JSON.stringify(segment)}`,
      );
    });

    it("does not let a command's control bytes break the dock's single line", () => {
      // Desired defensive contract: a command is data, so a newline or carriage return inside
      // it must not turn the one-line dock into a multi-line widget.
      addJob("job-1", "echo boom\nsecond line");
      setJobTimes("job-1", 100);

      render();

      const rendered = line();
      assert.equal(
        rendered.includes("\n"),
        false,
        `a command must not inject dock lines: ${JSON.stringify(rendered)}`,
      );
      assert.equal(
        rendered.includes("\r"),
        false,
        `a command must not inject carriage returns: ${JSON.stringify(rendered)}`,
      );
    });

    it("mounts the single completed shell with its runtime", () => {
      // Contract: once the only shell settled successfully, the docking line reports when it
      // completed; the kill hint stays, because the result is still worth inspecting.
      addJob("job-1", "echo done", "completed");
      setJobTimes("job-1", 5_000, 1_000);

      render();

      assert.equal(line(), "1 shell completed in 4s · /shell to open");
      assert.equal(ui.widgetCalls.at(-1)?.placement, "belowEditor");
      assert.deepEqual(ui.fgCalls, [
        { color: "success", text: "1 shell completed" },
        { color: "dim", text: " · /shell to open" },
      ]);
    });

    it("falls back to the count list when the running shell shares the list with settled shells", () => {
      // Contract: the dedicated running format is reserved for a list that holds nothing else;
      // as soon as another job settled, the summary switches to the count list and replaces the
      // command/elapsed segments.
      addJob("running", "sleep 30");
      addJob("completed-1", "echo one", "completed");
      addJob("completed-2", "echo two", "completed");

      render();

      assert.equal(
        line(),
        "3 shells · 1 running · 2 completed · /shell to open",
      );
      assert.equal(
        line().includes("sleep 30"),
        false,
        "the count list must not carry a command",
      );
      assert.doesNotMatch(
        line(),
        /\d+s ·/,
        "the count list must not carry an elapsed time",
      );
    });

    it("reports every status in running, completed, failed, killed order and omits empty ones", () => {
      addJob("running", "sleep 30", "running");
      addJob("completed", "echo done", "completed");
      addJob("failed", "exit 1", "failed");
      addJob("killed", "sleep 60", "killed");
      addJob("killed-2", "sleep 60", "killed");

      render();

      assert.equal(
        line(),
        "5 shells · 1 running · 1 completed · 1 failed · 2 killed · /shell to open",
      );
    });

    it("shows no running segment when every shell settled", () => {
      addJob("completed", "echo done", "completed");
      addJob("failed", "exit 1", "failed");

      render();

      assert.equal(
        line(),
        "2 shells · 1 completed · 1 failed · /shell to open",
      );
    });

    it("uses the count list for a single failed shell", () => {
      addJob("job-1", "exit 1", "failed");

      render();

      assert.equal(line(), "1 shell · 1 failed · /shell to open");
    });

    it("uses the count list for a single killed shell and marks it as an error", () => {
      // Contract: a killed shell has no dedicated single-job format, and its count is drawn in
      // the error colour like a failure - a killed background shell is worth noticing.
      addJob("job-1", "sleep 60", "killed");

      render();

      assert.equal(line(), "1 shell · 1 killed · /shell to open");
      assert.ok(
        ui.fgCalls.some(
          (call) => call.color === "error" && call.text === "1 killed",
        ),
        "the killed segment must be drawn in the error colour",
      );
    });

    it("draws the count list in the status colours of its segments", () => {
      // Contract: the count list keeps the status colours of the mixed single-format cases and
      // joins them with a dim separator; only the hint is dim as a whole.
      addJob("running", "sleep 30");
      addJob("completed", "echo done", "completed");
      addJob("failed", "exit 1", "failed");
      addJob("killed", "sleep 60", "killed");

      render();

      assert.ok(
        ui.fgCalls.some(
          (call) => call.color === "accent" && call.text === "1 running",
        ),
      );
      assert.ok(
        ui.fgCalls.some(
          (call) => call.color === "success" && call.text === "1 completed",
        ),
      );
      assert.ok(
        ui.fgCalls.some(
          (call) => call.color === "error" && call.text === "1 failed",
        ),
      );
      assert.ok(
        ui.fgCalls.some(
          (call) => call.color === "error" && call.text === "1 killed",
        ),
      );
      assert.ok(
        ui.fgCalls.some((call) => call.color === "dim" && call.text === " · "),
        "the count segments must be joined with a dim separator",
      );
      assert.deepEqual(ui.fgCalls.at(-1), {
        color: "dim",
        text: " · /shell to open",
      });
    });

    it("re-mounts the same key with updated content on every render", () => {
      // Contract: each render replaces the dock content under the same key; pi keeps one widget
      // per key, so later renders do not stack duplicate lines.
      addJob("job-1", "sleep 30", "running");
      addJob("job-2", "sleep 60", "running");
      render();
      assert.equal(line(), "2 shells · 2 running · /shell to open");

      shellManager.settleJob("job-2", { type: "completed", exitCode: 0 });
      render();

      assert.equal(
        line(),
        "2 shells · 1 running · 1 completed · /shell to open",
      );
      assert.deepEqual(ui.mountedKeys("belowEditor"), [WIDGET_KEY]);
    });

    it("keeps the command and elapsed seconds of the single running shell uncoloured", () => {
      // Contract: only the running count is accented; the command and elapsed seconds are plain
      // and the separators dim, so the summary is not one uniformly coloured block.
      addJob("job-1", "sleep 30");
      setJobTimes("job-1", 100);

      render();

      assert.deepEqual(ui.fgCalls, [
        { color: "accent", text: "1 running shell" },
        { color: "dim", text: " · " },
        { color: "dim", text: " · /shell to open" },
      ]);
    });

    it("refreshes the elapsed seconds every second and stops once nothing runs", () => {
      // Contract: while a shell runs, the dock re-renders on a one-second interval so the
      // elapsed segment advances without any other job event; the interval is torn down again
      // when the count reaches zero.
      mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
      try {
        addJob("job-1", "sleep 30");
        render();
        assert.equal(
          line(),
          "1 running shell · sleep 30 · 0s · /shell to open",
        );

        mock.timers.tick(1_000);
        assert.equal(
          line(),
          "1 running shell · sleep 30 · 1s · /shell to open",
        );

        mock.timers.tick(3_000);
        assert.equal(
          line(),
          "1 running shell · sleep 30 · 4s · /shell to open",
        );

        shellManager.settleJob("job-1", { type: "completed", exitCode: 0 });
        render();
        const callsAfterSettle = ui.widgetCalls.length;
        mock.timers.tick(5_000);
        assert.equal(
          ui.widgetCalls.length,
          callsAfterSettle,
          "the timer must stop when no shell runs",
        );
      } finally {
        shellManager.clearAllJobs();
        render();
        mock.timers.reset();
      }
    });
  });

  describe("clear", () => {
    it("removes only the dock widget", () => {
      addJob("job-1", "sleep 30");
      render();

      dock.clear();

      assert.equal(ui.mountedWidget("belowEditor", WIDGET_KEY), undefined);
      assert.deepEqual(ui.widgetCalls.at(-1), {
        key: WIDGET_KEY,
        content: undefined,
        placement: undefined,
      });
      assert.equal(dock.isSelected(), false);
    });

    it("does nothing without an interactive UI", () => {
      addJob("job-1", "sleep 30");
      dock.setCtx(createFakeContext("/work", { ui, hasUI: false }));

      dock.clear();

      assert.deepEqual(ui.widgetCalls, []);
    });
  });
});
