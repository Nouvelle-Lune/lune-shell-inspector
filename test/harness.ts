/**
 * Shared test harness for lune-shell-inspector.
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
 * The extension registers two tools: the `bash` wrapper described here and `background_shell`, the
 * inspector for the jobs the wrapper starts. Only `bash` needs the bash-specific driver below;
 * the inspector's definition is looked up through {@link loadRegisteredTool}.
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

import {
    SessionManager,
    createBashTool,
    createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
    AgentToolResult,
    AgentToolUpdateCallback,
    BashToolDetails,
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import luneShellInspectorExtension from "../src/index.ts";
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
    return mkdtempSync(join(tmpdir(), `lune-shell-inspector-${label}-`));
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
 * Session file
 * ---------------------------------------------------------------------------------------------- */

/**
 * One session entry, as the tests read it.
 *
 * The tree itself is the real `SessionManager`; this is the flattened shape the tests query (custom
 * entries carry `customType` and `data`, every entry carries its tree links).
 */
export interface FakeSessionEntry {
    id: string;
    parentId: string | null;
    timestamp: string;
    type: string;
    customType?: string;
    data?: unknown;
}

/** Read-only view of a session, i.e. the `ctx.sessionManager` the extension is handed. */
export type ReadonlySession = Pick<
    SessionManager,
    | "getCwd"
    | "getSessionDir"
    | "getSessionId"
    | "getSessionFile"
    | "getLeafId"
    | "getLeafEntry"
    | "getEntry"
    | "getLabel"
    | "getBranch"
    | "buildContextEntries"
    | "getHeader"
    | "getEntries"
    | "getTree"
    | "getSessionName"
>;

/** Flatten one real `SessionEntry` into the shape the tests assert on. */
function toFakeEntry(entry: unknown): FakeSessionEntry {
    const raw = entry as {
        id: string;
        parentId: string | null;
        timestamp: string;
        type: string;
        customType?: string;
        data?: unknown;
    };
    return {
        id: raw.id,
        parentId: raw.parentId ?? null,
        timestamp: raw.timestamp,
        type: raw.type,
        customType: raw.customType,
        data: raw.data,
    };
}

/** One entry a {@link FakeSessionLog} can be seeded with, as a session file holds it. */
export interface SeededSessionEntry {
    id: string;
    parentId: string | null;
    type: string;
    customType?: string;
    data?: unknown;
}

/** Options for {@link FakeSessionLog}. */
export interface FakeSessionLogOptions {
    /** Working directory recorded in the session. */
    cwd?: string;
    /**
     * Entries the session starts with, in file order (`parentId` links build the tree).
     *
     * Seeding exists because pi allocates entry ids itself: a test that needs readable fixture ids
     * (`root`, `m1`) has to hand them to the manager once, exactly as replaying a session file does.
     */
    entries?: SeededSessionEntry[];
}

/**
 * A session as it persists: the real pi `SessionManager`, plus the small test-facing surface around it.
 *
 * The tree, the active leaf, entry ids and `getBranch()` are pi's own implementation
 * (`SessionManager.inMemory()`) - the tests must not reimplement the semantics the extension is
 * built on. What this wrapper adds is only what a test needs to inspect and arrange a session:
 * `entries()` / `entry()` snapshots, `leafId` / `setLeaf()` to model `/tree` navigation and
 * `/resume`, and an `append()` for fixtures.
 *
 * A log survives an extension instance deliberately: reopening a session (startup after `/quit`,
 * `/resume`) only registers a new extension over the same manager.
 */
export class FakeSessionLog {
    private readonly manager: SessionManager;

    constructor(options: FakeSessionLogOptions = {}) {
        const cwd = options.cwd ?? process.cwd();
        const seeded = options.entries ?? [];
        this.manager =
            seeded.length === 0
                ? SessionManager.inMemory(cwd)
                : SessionManager.inMemory(cwd, {}, [newSessionHeader(cwd), ...seeded.map(toFileEntry)]);
    }

    /** The real session manager this log wraps. */
    get sessionManager(): SessionManager {
        return this.manager;
    }

    /** Every entry of the session, in append order. */
    entries(): FakeSessionEntry[] {
        return this.manager.getEntries().map(toFakeEntry);
    }

    /** The entry with `id`, or undefined. */
    entry(id: string): FakeSessionEntry | undefined {
        const entry = this.manager.getEntry(id);
        return entry ? toFakeEntry(entry) : undefined;
    }

    /** The active branch, root first - pi's `getBranch()`. */
    getBranch(fromId?: string): FakeSessionEntry[] {
        return this.manager.getBranch(fromId).map(toFakeEntry);
    }

    /** The active leaf, i.e. the parent new entries are appended under. */
    get leafId(): string | null {
        return this.manager.getLeafId();
    }

    /** Move the active leaf without deleting anything - pi's `sessionManager.branch(id)`. */
    setLeaf(leafId: string | null): void {
        if (leafId === null) {
            this.manager.resetLeaf();
            return;
        }
        this.manager.branch(leafId);
    }

    /**
     * Append a fixture entry as a child of the current leaf and advance the leaf to it.
     *
     * Messages go through `appendMessage`, custom entries through `appendCustomEntry`, so the entry
     * shape, the allocated id and the leaf bookkeeping are all pi's.
     */
    append(entry: { type: string; customType?: string; data?: unknown }): FakeSessionEntry {
        if (entry.type === "custom") {
            if (entry.customType === undefined) {
                throw new Error("a custom fixture entry needs a customType");
            }
            const id = this.manager.appendCustomEntry(entry.customType, entry.data);
            const stored = this.entry(id);
            if (!stored) {
                throw new Error(`appendCustomEntry did not store ${id}`);
            }
            return stored;
        }
        return this.appendMessage(`fixture-${entry.type}`);
    }

    /** Append a user message entry, pi's way, and return the stored entry. */
    appendMessage(text: string): FakeSessionEntry {
        const id = this.manager.appendMessage({
            role: "user",
            content: text,
            timestamp: Date.now(),
        } as never);
        const stored = this.entry(id);
        if (!stored) {
            throw new Error(`appendMessage did not store ${id}`);
        }
        return stored;
    }

    /** The newest entry with the given custom type, or undefined. */
    latestCustom(customType: string): FakeSessionEntry | undefined {
        return this.entries()
            .filter((entry) => entry.customType === customType)
            .at(-1);
    }

    /** The newest entry with the given custom type; throws when the session holds none. */
    leafOf(customType: string, fromIndex = 0): string {
        const matches = this.entries().filter((entry) => entry.customType === customType);
        const found = matches[matches.length - 1 - fromIndex];
        if (!found) {
            throw new Error(`no ${customType} entry in the session log`);
        }
        return found.id;
    }

    private lastEntry(): FakeSessionEntry | undefined {
        return this.entries().at(-1);
    }
}
/** A minimal session header for a seeded in-memory session. */
function newSessionHeader(cwd: string): never {
    return {
        type: "session",
        version: 3,
        id: `test-session-${Date.now()}`,
        timestamp: new Date().toISOString(),
        cwd,
    } as never;
}

/** Convert a seeded entry into the file shape pi replays. */
function toFileEntry(entry: SeededSessionEntry): never {
    const timestamp = new Date().toISOString();
    if (entry.type === "custom") {
        return {
            type: "custom",
            id: entry.id,
            parentId: entry.parentId,
            timestamp,
            customType: entry.customType,
            data: entry.data,
        } as never;
    }
    return {
        type: "message",
        id: entry.id,
        parentId: entry.parentId,
        timestamp,
        message: { role: "user", content: entry.id, timestamp: Date.now() },
    } as never;
}

/**
 * The session context handed to handlers: a session over `log`'s real manager, read-only.
 *
 * Reads go straight to the real manager, so `getBranch()` answers exactly as it does in pi.
 */
function sessionContext(log: FakeSessionLog | undefined): ReadonlySession {
    return (log?.sessionManager ?? SessionManager.inMemory()) as unknown as ReadonlySession;
}

/** An empty session manager for a session that has no log yet. */
export function emptySessionManager(): ReadonlySession {
    return SessionManager.inMemory() as unknown as ReadonlySession;
}

/** Record one `pi.appendEntry` call, in call order. */
export interface AppendEntryCall {
    customType: string;
    data: unknown;
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
    /**
     * Session backing `ctx.sessionManager`; a fresh empty one by default.
     *
     * Pass the same log to two contexts to model one session being reopened (startup after `/quit`,
     * `/resume`), and a different log to model another session file (`/new`, `/resume` elsewhere).
     */
    sessionLog?: FakeSessionLog;
}

/**
 * Minimal extension context pi would pass to a session handler or a tool call.
 *
 * `ui` is a {@link FakeExtensionUi} and `hasUI` defaults to `true`; set `hasUI: false` to model a
 * print/RPC session without an interactive UI. `cwd` is what the extension reads for the shell job
 * and for the delegated bash tool; `sessionManager` is the session's real pi `SessionManager`.
 */
export function createFakeContext(cwd: string, options: FakeContextOptions = {}): ExtensionContext {
    const ui = options.ui ?? createFakeUi();
    return {
        cwd,
        hasUI: options.hasUI ?? true,
        ui,
        sessionManager: sessionContext(options.sessionLog),
    } as unknown as ExtensionContext;
}

/**
 * Extension event name the fake host can fire; mirrors the session events pi emits.
 *
 * `session_before_tree` fires before pi switches the session's leaf, `session_tree` after - the
 * split the extension relies on to persist the departing branch's shell state.
 */
export type PiEventName =
    | "session_start"
    | "session_before_tree"
    | "session_tree"
    | "session_shutdown";

/** Handler shape accepted by `pi.on`; the extension's handlers take `(event, ctx)`. */
export type PiEventHandler = (event: unknown, ctx: ExtensionContext, ...rest: unknown[]) => unknown;

/**
 * Minimal fake pi host: captures `registerTool` definitions, `registerCommand` handlers and
 * `pi.on` handlers.
 *
 * A real pi fires the session events itself; a test drives them through {@link emit} so it controls
 * when the extension subscribes to the shell manager and which context renders the dock.
 * `appendEntry` records into the {@link FakeSessionLog} the host was created for (if any) and
 * mirrors pi's behaviour of throwing outside a session.
 */
export interface FakePiHost {
    readonly registeredTools: readonly BashToolDefinition[];
    readonly registeredCommands: readonly RegisteredCommand[];
    /** Custom messages the extension sent to the session, in call order. */
    readonly sendMessageCalls: readonly SendMessageCall[];
    /** `pi.appendEntry` calls, in call order. */
    readonly appendEntryCalls: readonly AppendEntryCall[];
    /** Fire one extension event with the given context, awaiting every handler. */
    emit(event: PiEventName, ctx: ExtensionContext, payload?: Record<string, unknown>): Promise<void>;
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
 *
 * `appendEntry` routes to the real `SessionManager.appendCustomEntry` of the host's session, the
 * same call pi makes, so a persisted snapshot lands on the branch's actual leaf and shows up in
 * `log.getBranch()` exactly as in a live session.
 */
export function registerExtension(cwd: string, sessionLog?: FakeSessionLog): FakePiHost {
    const previousCwd = process.cwd();
    const registeredTools: BashToolDefinition[] = [];
    const registeredCommands: RegisteredCommand[] = [];
    const sendMessageCalls: SendMessageCall[] = [];
    const appendEntryCalls: AppendEntryCall[] = [];
    const handlersByEvent = new Map<PiEventName, PiEventHandler[]>();
    const sessionManager = sessionLog?.sessionManager;

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
        appendEntry: (customType: string, data?: unknown) => {
            appendEntryCalls.push({ customType, data });
            // pi's own routing: the session manager owns the leaf and the entry id.
            sessionManager?.appendCustomEntry(customType, data);
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
        luneShellInspectorExtension(api);
    } finally {
        process.chdir(previousCwd);
    }

    return {
        registeredTools,
        registeredCommands,
        sendMessageCalls,
        appendEntryCalls,
        handlers: (event) => handlersByEvent.get(event) ?? [],
        async emit(event, ctx, payload) {
            for (const handler of handlersByEvent.get(event) ?? []) {
                await handler({ type: event, ...payload }, ctx);
            }
        },
    };
}

/** The tool definition the extension registered under `name`, for a load-time cwd of `cwd`. */
export function loadRegisteredTool(cwd: string, name: string): BashToolDefinition {
    const tool = registerExtension(cwd).registeredTools.find((entry) => entry.name === name);
    if (!tool) {
        throw new Error(`lune-shell-inspector did not register a "${name}" tool`);
    }
    return tool;
}

/** The `bash` tool the extension registers for a load-time working directory of `cwd`. */
export function loadBashTool(cwd: string): BashToolDefinition {
    return loadRegisteredTool(cwd, "bash");
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
    /** Session log backing `ctx.sessionManager` and the host's `appendEntry`. */
    sessionLog: FakeSessionLog;
}

/**
 * Load the extension for `cwd` and start a session against a fake context.
 *
 * Firing `session_start` is what pi always does before a tool call; the extension's command
 * announcement depends on that handler having captured a context, and the shell dock subscription
 * only exists afterwards. The session itself is a real `SessionManager`, so `pi.appendEntry` and
 * `ctx.sessionManager` share its leaf exactly as they do in pi.
 */
export async function openSession(
    cwd: string,
    options: FakeContextOptions = {},
): Promise<ExtensionSession> {
    const sessionLog = options.sessionLog ?? new FakeSessionLog({ cwd });
    const host = registerExtension(cwd, sessionLog);
    const tool = host.registeredTools.find((entry) => entry.name === "bash");
    if (!tool) {
        throw new Error('lune-shell-inspector did not register a "bash" tool');
    }
    const ui = options.ui ?? createFakeUi();
    const ctx = createFakeContext(cwd, { ...options, ui, sessionLog });
    await host.emit("session_start", ctx);
    return { host, tool, ctx, ui, sessionLog };
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
