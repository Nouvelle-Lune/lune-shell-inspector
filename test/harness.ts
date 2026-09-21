/**
 * Shared test harness for pi-shell-view.
 *
 * The extension is a wrapper around pi's built-in `bash` tool: while loading it copies the built-in
 * description and parameter schema, and at call time it announces the command and then delegates to
 * `createBashTool(cwd)`. Around that it keeps a `ShellManager` alive: `session_start` subscribes and
 * renders the shell dock through `ctx.ui.setWidget`, every job mutation re-renders it, and
 * `session_shutdown` unsubscribes and clears it.
 *
 * The harness reproduces only what the extension actually consumes from pi:
 * - a minimal fake host that captures registered tools and `pi.on` handlers, so a test can fire
 *   `session_start` / `session_shutdown` itself;
 * - a fake extension context whose `ui.setWidget` models pi's real keyed widget registry
 *   (`setExtensionWidget`: placement buckets, key replacement, reinsertion moves a key to the end);
 * - real command execution through the delegated implementation.
 * Renderers, themes and the TUI itself are not simulated; the real TUI is observed through
 * `test/tui`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBashTool } from "@earendil-works/pi-coding-agent";
import type {
    AgentToolResult,
    AgentToolUpdateCallback,
    BashToolDetails,
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import shellViewExtension from "../src/index.ts";

/** Tool definition the extension registers; the parameter schema stays opaque for the harness. */
export type BashToolDefinition = ToolDefinition<any, any, any>;

/** Arguments the built-in bash tool accepts; mirrors its TypeBox schema. */
export interface BashToolParams {
    command: string;
    timeout?: number;
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

/**
 * Extension UI fake with pi's widget semantics.
 *
 * `setWidget` mirrors pi's `setExtensionWidget`: content is stored per placement bucket under the
 * key, `undefined` removes the key, and re-setting an existing key removes then re-inserts it, so
 * the key moves to the end of its bucket (the behaviour pi-subagents' renderer explicitly works
 * around). Every call is also captured verbatim so tests can assert what the extension asked for.
 */
export interface FakeExtensionUi {
    readonly notifyCalls: readonly NotifyCall[];
    readonly widgetCalls: readonly WidgetCall[];
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

    return {
        notifyCalls,
        widgetCalls,

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
 * Minimal fake pi host: captures `registerTool` definitions and `pi.on` handlers.
 *
 * A real pi fires the session events itself; a test drives them through {@link emit} so it controls
 * when the extension subscribes to the shell manager and which context renders the dock.
 */
export interface FakePiHost {
    readonly registeredTools: readonly BashToolDefinition[];
    /** Fire one extension event with the given context, awaiting every handler. */
    emit(event: PiEventName, ctx: ExtensionContext): Promise<void>;
    /** Currently registered handlers for an event, in registration order. */
    handlers(event: PiEventName): readonly PiEventHandler[];
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
    const handlersByEvent = new Map<PiEventName, PiEventHandler[]>();

    const api = {
        registerTool: (tool: BashToolDefinition) => {
            registeredTools.push(tool);
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
    const params: BashToolParams =
        options.timeout === undefined ? { command: options.command } : { command: options.command, timeout: options.timeout };
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
