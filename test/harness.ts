/**
 * Shared test harness for pi-shell-view.
 *
 * The extension is a wrapper around pi's built-in `bash` tool with two execution paths:
 * - foreground (the default): the call is delegated to `createBashTool(ctx.cwd)` unchanged and is
 *   never recorded anywhere;
 * - background (`mode: "background"`): the call returns immediately with a `Background shell
 *   started ...` result while `startBackgroundShell` runs the command through pi's local bash
 *   operations and records it as a `ShellManager` job (streamed output, exit code, timeout kill).
 * Around both paths it keeps a `ShellManager` alive: `session_start` subscribes and renders the
 * shell dock through `ctx.ui.setWidget`, every job mutation re-renders it, and `session_shutdown`
 * unsubscribes and clears it.
 *
 * The harness reproduces only what the extension actually consumes from pi:
 * - a minimal fake host that captures registered tools and `pi.on` handlers, so a test can fire
 *   `session_start` / `session_shutdown` itself;
 * - a fake extension context whose `ui.setWidget` models pi's real keyed widget registry
 *   (`setExtensionWidget`: placement buckets, key replacement, reinsertion moves a key to the end),
 *   and whose `ui.theme.fg` records every colour request while returning the text unstyled;
 * - real command execution through the delegated implementation.
 * Renderers are called directly by the registration tests, which pin the delegation contract; the
 * TUI itself is not simulated, and the real TUI is observed through `test/tui`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBashTool, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
    AgentToolResult,
    AgentToolUpdateCallback,
    BashToolDetails,
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import shellViewExtension from "../src/index.ts";
import { shellManager, type ShellJob } from "../src/shell/shell-manager.ts";

/** Tool definition the extension registers; the parameter schema stays opaque for the harness. */
export type BashToolDefinition = ToolDefinition<any, any, any>;

/** Execution mode the registered tool accepts; omitted means `foreground`. */
export type BashMode = "foreground" | "background";

/** Arguments the built-in bash tool accepts; mirrors its TypeBox schema plus the wrapper's `mode`. */
export interface BashToolParams {
    command: string;
    timeout?: number;
    mode?: BashMode;
}

/** Payload of one `onUpdate` callback or of the final result; `details` is the bash tool details. */
export type BashToolResult = AgentToolResult<BashToolDetails | undefined>;

/**
 * Execute signature of the registered tool.
 *
 * pi's agent loop always supplies an extension context as the fifth argument; the extension uses it
 * for the shell dock and the delegated built-in bash tool is called with that context's cwd, which
 * is why the working directory pi reports reaches the command. The harness drives the tool the same
 * way and leaves `ctx` optional so the built-in implementation can also be measured without one.
 */
type ToolExecute = (
    toolCallId: string,
    params: BashToolParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    ctx?: ExtensionContext,
) => Promise<BashToolResult>;

/** Text of the first content block; the built-in bash tool returns a single text block. */
export function resultText(result: BashToolResult): string {
    const first = result.content.at(0);
    return first?.type === "text" ? first.text : "";
}

/** Result of a call that must have succeeded. */
export function requireResult(run: BashRun): BashToolResult {
    if (run.failed) {
        throw new Error(`expected the call to succeed, got: ${run.error?.message ?? ""}`);
    }
    if (!run.result) {
        throw new Error("expected the tool to return a result");
    }
    return run.result;
}

/** Error of a call that must have failed instead of returning a result. */
export function requireError(run: BashRun): Error {
    if (run.result !== undefined) {
        throw new Error("a failing call must not return a result");
    }
    if (!run.error) {
        throw new Error("expected the tool to throw");
    }
    return run.error;
}

/** Create an isolated working directory for a loaded extension or a command. */
export function createTempWorkDir(label: string): string {
    return mkdtempSync(join(tmpdir(), `pi-shell-view-${label}-`));
}

/** Remove a directory created by {@link createTempWorkDir}. */
export function removeTempWorkDir(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}

/* -------------------------------------------------------------------------------------------------
 * Fake extension UI
 * ---------------------------------------------------------------------------------------------- */

/** Frozen copy of pi's widget placements (`setExtensionWidget` defaults to `aboveEditor`). */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/**
 * Widget payload accepted by `ctx.ui.setWidget`.
 *
 * pi renders a `string[]` as text lines (capped at `MAX_WIDGET_LINES`) and a component factory as
 * an arbitrary component; the shell dock only ever passes the array form or `undefined`.
 */
export type WidgetContent = readonly string[] | ((...args: unknown[]) => unknown);

/** One captured `setWidget` call, in call order. */
export interface WidgetCall {
    key: string;
    content: WidgetContent | undefined;
    /** Placement the call passed, or `undefined` when it relied on pi's `aboveEditor` default. */
    placement: WidgetPlacement | undefined;
}

/** One captured `notify` call, in call order. */
export interface NotifyCall {
    message: string;
    type: string | undefined;
}

/** One captured `pi.sendMessage` call, in call order. */
export interface SendMessageCall {
    message: {
        customType: string;
        content: unknown;
        display?: boolean;
        details?: unknown;
    };
    options?: {
        triggerTurn?: boolean;
        deliverAs?: "steer" | "followUp" | "nextTurn";
    };
}

/** One captured `theme.fg` request, in call order. */
export interface ThemeFgCall {
    color: string;
    text: string;
}

/**
 * Extension UI fake with pi's widget semantics.
 *
 * `setWidget` mirrors pi's `setExtensionWidget`: content is stored per placement bucket under the
 * key, `undefined` removes the key, and re-setting an existing key removes then re-inserts it, so
 * the key moves to the end of its bucket (the behaviour pi-subagents' renderer explicitly works
 * around). Every call is also captured verbatim so tests can assert what the extension asked for.
 * `theme.fg` records its colour and returns the text unchanged: the tests assert the readable line
 * and the requested colour separately, instead of an ANSI escape sequence.
 */
export interface FakeExtensionUi {
    readonly notifyCalls: readonly NotifyCall[];
    readonly widgetCalls: readonly WidgetCall[];
    readonly fgCalls: readonly ThemeFgCall[];
    readonly theme: { fg(color: string, text: string): string };
    notify(message: string, type?: string): void;
    setWidget(key: string, content: WidgetContent | undefined, options?: { placement?: WidgetPlacement }): void;
    /** Content currently mounted for `key`, or `undefined` when the key is not mounted. */
    mountedWidget(placement: WidgetPlacement, key: string): WidgetContent | undefined;
    /** Mounted keys of a placement bucket, in pi's reinsertion order. */
    mountedKeys(placement: WidgetPlacement): readonly string[];
}

/** Create a fake extension UI that records `notify` and models pi's keyed widget registry. */
export function createFakeUi(): FakeExtensionUi {
    const buckets: Record<WidgetPlacement, Map<string, WidgetContent>> = {
        aboveEditor: new Map(),
        belowEditor: new Map(),
    };
    const notifyCalls: NotifyCall[] = [];
    const widgetCalls: WidgetCall[] = [];
    const fgCalls: ThemeFgCall[] = [];

    return {
        notifyCalls,
        widgetCalls,
        fgCalls,

        theme: {
            fg(color, text) {
                fgCalls.push({ color, text });
                return text;
            },
        },

        notify(message, type) {
            notifyCalls.push({ message, type });
        },

        setWidget(key, content, options) {
            const placement = options?.placement ?? "aboveEditor";
            widgetCalls.push({ key, content, placement: options?.placement });

            // pi removes the key from both buckets before inserting, so a repeat call reorders it.
            buckets.aboveEditor.delete(key);
            buckets.belowEditor.delete(key);
            if (content !== undefined) {
                buckets[placement].set(key, content);
            }
        },

        mountedWidget(placement, key) {
            return buckets[placement].get(key);
        },

        mountedKeys(placement) {
            return [...buckets[placement].keys()];
        },
    };
}

/* -------------------------------------------------------------------------------------------------
 * Fake extension context and pi host
 * ---------------------------------------------------------------------------------------------- */

/** Options for {@link createFakeContext}. */
export interface FakeContextOptions {
    /** Value of `ctx.hasUI`; `true` by default, like an interactive pi session. */
    hasUI?: boolean;
    /** UI to expose as `ctx.ui`; a fresh {@link createFakeUi} by default. */
    ui?: FakeExtensionUi;
}

/**
 * Minimal extension context pi would pass to a session handler or a tool call.
 *
 * `ui` is a {@link FakeExtensionUi} and `hasUI` defaults to `true`; set `hasUI: false` to model a
 * print/RPC session without an interactive UI. `cwd` is what the extension reads for the shell job
 * and for the delegated bash tool.
 */
export function createFakeContext(cwd: string, options: FakeContextOptions = {}): ExtensionContext {
    const ui = options.ui ?? createFakeUi();
    return {
        cwd,
        hasUI: options.hasUI ?? true,
        ui,
    } as unknown as ExtensionContext;
}

/** Extension event name the fake host can fire. */
export type PiEventName = "session_start" | "session_shutdown";

/** Handler shape accepted by `pi.on`; the extension's handlers take `(event, ctx)`. */
export type PiEventHandler = (event: unknown, ctx: ExtensionContext, ...rest: unknown[]) => unknown;

/**
 * Minimal fake pi host: captures `registerTool` definitions, `registerCommand` handlers and
 * `pi.on` handlers.
 *
 * A real pi fires the session events itself; a test drives them through {@link emit} so it controls
 * when the extension subscribes to the shell manager and which context renders the dock.
 */
export interface FakePiHost {
    readonly registeredTools: readonly BashToolDefinition[];
    readonly registeredCommands: readonly RegisteredCommand[];
    /** Custom messages the extension sent to the session, in call order. */
    readonly sendMessageCalls: readonly SendMessageCall[];
    /** Fire one extension event with the given context, awaiting every handler. */
    emit(event: PiEventName, ctx: ExtensionContext): Promise<void>;
    /** Currently registered handlers for an event, in registration order. */
    handlers(event: PiEventName): readonly PiEventHandler[];
}

/** A custom command the extension registered with `pi.registerCommand`. */
export interface RegisteredCommand {
    name: string;
    description: string | undefined;
    handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

/**
 * Register the extension against a minimal fake pi host and return the host.
 *
 * The extension captures `process.cwd()` while the factory runs, and that captured directory is
 * also the built-in bash tool's working directory. The harness chdirs into `cwd` for the
 * registration call and restores the previous directory afterwards.
 */
export function registerExtension(cwd: string): FakePiHost {
    const previousCwd = process.cwd();
    const registeredTools: BashToolDefinition[] = [];
    const registeredCommands: RegisteredCommand[] = [];
    const sendMessageCalls: SendMessageCall[] = [];
    const handlersByEvent = new Map<PiEventName, PiEventHandler[]>();

    const api = {
        registerTool: (tool: BashToolDefinition) => {
            registeredTools.push(tool);
        },
        registerCommand: (
            name: string,
            options: Omit<RegisteredCommand, "name">,
        ) => {
            registeredCommands.push({
                name,
                description: options.description,
                handler: options.handler,
            });
        },
        sendMessage: (message: SendMessageCall["message"], options?: SendMessageCall["options"]) => {
            sendMessageCalls.push({ message, options });
        },
        on: (event: PiEventName, handler: PiEventHandler) => {
            const handlers = handlersByEvent.get(event) ?? [];
            handlers.push(handler);
            handlersByEvent.set(event, handlers);
            return () => {
                const current = handlersByEvent.get(event);
                if (!current) {
                    return;
                }
                const index = current.indexOf(handler);
                if (index !== -1) {
                    current.splice(index, 1);
                }
            };
        },
    } as unknown as ExtensionAPI;

    process.chdir(cwd);
    try {
        shellViewExtension(api);
    } finally {
        process.chdir(previousCwd);
    }

    return {
        registeredTools,
        registeredCommands,
        sendMessageCalls,
        handlers: (event) => handlersByEvent.get(event) ?? [],
        async emit(event, ctx) {
            for (const handler of handlersByEvent.get(event) ?? []) {
                await handler({ type: event }, ctx);
            }
        },
    };
}

/** The `bash` tool the extension registers for a load-time working directory of `cwd`. */
export function loadBashTool(cwd: string): BashToolDefinition {
    const tool = registerExtension(cwd).registeredTools.find((entry) => entry.name === "bash");
    if (!tool) {
        throw new Error('pi-shell-view did not register a "bash" tool');
    }
    return tool;
}

/**
 * The built-in bash tool the extension delegates to, created for `cwd`.
 *
 * Used as the oracle of the delegation contract: a command run through the registered tool must
 * produce exactly what a direct call to this implementation produces.
 */
export function createBuiltInBash(cwd: string): BashToolDefinition {
    return createBashTool(cwd) as unknown as BashToolDefinition;
}

/**
 * The built-in bash tool *definition* the extension's foreground renderers delegate to.
 *
 * `createBashTool(cwd)` returns the AgentTool form, which carries no renderers; the registration
 * tests need the definition form to compare the wrapper's foreground rows with the built-in ones.
 */
export function createBuiltInBashDefinition(cwd: string): BashToolDefinition {
    return createBashToolDefinition(cwd) as unknown as BashToolDefinition;
}

/** A loaded extension plus the session it was started in. */
export interface ExtensionSession {
    host: FakePiHost;
    tool: BashToolDefinition;
    ctx: ExtensionContext;
    ui: FakeExtensionUi;
}

/**
 * Load the extension for `cwd` and start a session against a fake context.
 *
 * Firing `session_start` is what pi always does before a tool call; the extension's command
 * announcement depends on that handler having captured a context, and the shell dock subscription
 * only exists afterwards.
 */
export async function openSession(
    cwd: string,
    options: FakeContextOptions = {},
): Promise<ExtensionSession> {
    const host = registerExtension(cwd);
    const tool = host.registeredTools.find((entry) => entry.name === "bash");
    if (!tool) {
        throw new Error('pi-shell-view did not register a "bash" tool');
    }
    const ui = options.ui ?? createFakeUi();
    const ctx = createFakeContext(cwd, { ...options, ui });
    await host.emit("session_start", ctx);
    return { host, tool, ctx, ui };
}

/* -------------------------------------------------------------------------------------------------
 * Bash call driver
 * ---------------------------------------------------------------------------------------------- */

/** Options for {@link runBashCommand}. */
export interface BashRunOptions {
    /** Command handed to the tool. */
    command: string;
    /** Optional timeout in seconds, forwarded through the tool params. */
    timeout?: number;
    /** Execution mode; omitted means the tool's own `foreground` default. */
    mode?: BashMode;
    /** Abort signal handed to the tool; a fresh, never aborted signal by default. */
    signal?: AbortSignal;
    toolCallId?: string;
    /**
     * Extension context the tool is called with, defaulting to {@link createFakeContext} for
     * `process.cwd()`. Pass `null` to call the tool without a context, the way a direct built-in
     * call can be measured.
     */
    ctx?: ExtensionContext | null;
    /** Called for every `onUpdate` payload before the tool's own `details` handling. */
    onUpdate?: (update: BashToolResult) => void;
}

/** Everything one tool call produced. */
export interface BashRun {
    toolCallId: string;
    command: string;
    /** Raw `onUpdate` payloads, in call order. */
    updates: BashToolResult[];
    /** Result of a successful call; undefined when the call failed. */
    result: BashToolResult | undefined;
    /** Error the delegated implementation threw; undefined when the call succeeded. */
    error: Error | undefined;
    /** True when the tool threw instead of returning a result. */
    failed: boolean;
    durationMs: number;
}

/** Text the call reported: the result body on success, the thrown error message on failure. */
export function reportedText(run: BashRun): string {
    if (run.result) {
        return resultText(run.result);
    }
    return run.error?.message ?? "";
}

/**
 * Drive one tool call with real command execution.
 *
 * A failure is recorded on {@link BashRun} instead of being thrown so a test can assert both that
 * the call failed and how; the error object itself is never swallowed or rewritten. Every
 * `onUpdate` payload the tool emits is collected in order.
 */
export async function runBashCommand(tool: BashToolDefinition, options: BashRunOptions): Promise<BashRun> {
    const toolCallId = options.toolCallId ?? "call-1";
    const params: BashToolParams = { command: options.command };
    if (options.timeout !== undefined) {
        params.timeout = options.timeout;
    }
    if (options.mode !== undefined) {
        params.mode = options.mode;
    }
    const ctx = options.ctx === null ? undefined : (options.ctx ?? createFakeContext(process.cwd()));
    const signal = options.signal ?? new AbortController().signal;
    const execute = tool.execute as unknown as ToolExecute;

    const updates: BashToolResult[] = [];
    const collect = (update: BashToolResult): void => {
        updates.push(update);
        options.onUpdate?.(update);
    };

    const startedAt = Date.now();
    let result: BashToolResult | undefined;
    let error: Error | undefined;
    try {
        result =
            ctx === undefined
                ? await execute(toolCallId, params, signal, collect)
                : await execute(toolCallId, params, signal, collect, ctx);
    } catch (thrown) {
        error = thrown instanceof Error ? thrown : new Error(String(thrown));
    }
    const durationMs = Date.now() - startedAt;

    return { toolCallId, command: options.command, updates, result, error, failed: error !== undefined, durationMs };
}

/* -------------------------------------------------------------------------------------------------
 * Background calls
 * ---------------------------------------------------------------------------------------------- */

/** A background call that returned while its job is still owned by the shell manager. */
export interface BackgroundBashStart {
    /** The immediate result of the tool call, recorded like any other {@link BashRun}. */
    run: BashRun;
    /** Id the shell job is tracked under: the tool call id. */
    jobId: string;
}

/**
 * Call the registered tool with `mode: "background"` and return immediately.
 *
 * The tool is expected to answer right away with a `Background shell started ...` result; the
 * command keeps running in the manager. Use {@link waitForJobSettled} or
 * {@link runBackgroundBashCommand} to observe how the job ends.
 */
export function startBackgroundBashCommand(
    tool: BashToolDefinition,
    options: BashRunOptions,
): Promise<BackgroundBashStart> {
    return runBashCommand(tool, { ...options, mode: "background" }).then((run) => ({
        run,
        jobId: run.toolCallId,
    }));
}

/** Default deadline for a background job to leave the `running` state. */
export const JOB_SETTLE_TIMEOUT_MS = 15_000;

/**
 * Wait until a shell job reaches a settled status (`completed`, `failed` or `killed`).
 *
 * Polls through the manager's subscription rather than sleeping: the promise resolves on the job
 * mutation that settles the job, and rejects when the deadline passes first. A job that is already
 * settled when the wait starts resolves immediately.
 */
export function waitForJobSettled(
    jobId: string,
    timeoutMs: number = JOB_SETTLE_TIMEOUT_MS,
): Promise<Readonly<ShellJob>> {
    return new Promise((resolve, reject) => {
        let unsubscribe: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let finished = false;

        const finish = (settle: () => void): void => {
            if (finished) {
                return;
            }
            finished = true;
            if (timer) {
                clearTimeout(timer);
            }
            unsubscribe?.();
            settle();
        };

        const settledJob = (): Readonly<ShellJob> | undefined => {
            const job = shellManager.getJob(jobId);
            return job && job.status !== "running" ? job : undefined;
        };

        // Subscribe before the first check so a job that settles in between is never missed.
        unsubscribe = shellManager.subscribe(() => {
            const job = settledJob();
            if (job) {
                finish(() => resolve(job));
            }
        });

        timer = setTimeout(() => {
            const job = shellManager.getJob(jobId);
            finish(() =>
                reject(
                    new Error(
                        `shell job ${JSON.stringify(jobId)} did not settle within ${timeoutMs}ms ` +
                        `(status ${JSON.stringify(job?.status)}, output ${JSON.stringify(job?.output.content ?? "")})`,
                    ),
                ),
            );
        }, timeoutMs);

        const job = settledJob();
        if (job) {
            finish(() => resolve(job));
        }
    });
}

/** Start a background call and wait for the job it created to settle. */
export async function runBackgroundBashCommand(
    tool: BashToolDefinition,
    options: BashRunOptions,
): Promise<{ run: BashRun; job: Readonly<ShellJob> }> {
    const { run, jobId } = await startBackgroundBashCommand(tool, options);
    const job = await waitForJobSettled(jobId);
    return { run, job };
}

/**
 * Poll until `predicate` holds, or fail once the deadline passes.
 *
 * Used by tests that observe a background job while it is still streaming: the job's output grows in
 * chunks, so the test waits for a marker instead of sleeping for a fixed time.
 */
export async function waitFor(
    description: string,
    predicate: () => boolean,
    timeoutMs: number = 5_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/**
 * The job's screen once the emulator has executed everything written to it so far.
 *
 * Jobs stream raw VT instructions into a headless terminal, which parses queued writes on a later
 * tick, so a reader that looks at the screen right after a chunk arrived would still see the
 * previous screen. Flushing through the same queue makes the read deterministic.
 */
export async function readJobScreen(jobId: string): Promise<string[]> {
    const terminal = shellManager.getJob(jobId)?.terminal;
    if (!terminal) {
        throw new Error(`cannot read the screen of unknown shell job ${JSON.stringify(jobId)}`);
    }

    await new Promise<void>((resolve) => terminal.write("", () => resolve()));

    return shellManager.getScreenLines(jobId);
}
