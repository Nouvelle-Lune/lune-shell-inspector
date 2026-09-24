/**
 * The `bash` tool lune-shell-inspector registers in place of pi's built-in one.
 *
 * pi uses the definition registered under an existing name instead of the built-in one.
 * `mode: "foreground"` (the default) delegates the call to the built-in bash tool unchanged;
 * `mode: "background"` starts a managed shell job whose execution continues after the call returned
 * and is reported by the shell dock. pi's `withBuiltInRenderers` only fills renderers a definition
 * does not supply, so the wrapper ships its own: a foreground row delegates to the built-in bash
 * renderers (keeping the standard `$ <command>` look and never drifting from it), while a background
 * row renders empty because the detached job is reported by the shell dock and the `/shell`
 * inspector, not by a transcript row that could never stream the output.
 *
 * The same module also defines `background_shell`, the pull side of background mode: the immediate
 * `bash` result cannot report a detached job, so the model needs a way to ask for a job's current
 * status or intermediate output before the completion notification arrives. Both definitions read
 * the same module-level `ShellManager`, so a job started through one is visible to the other.
 */
import {
    createBashTool,
    createBashToolDefinition,
    defineTool,
    type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import Type from "typebox";

import { startBackgroundShell } from "./background-bash.ts";

import { shellManager, type ShellJob } from "../shell/shell-manager.ts";
/**
 * Build the wrapper definition for one extension load.
 *
 * A factory rather than a module-level constant: the built-in definition binds its working
 * directory at construction time, so the definition must be built where the load-time cwd is known
 * and can later take extension-level configuration.
 */
export function BashTool() {
    // Reuse the built-in definition and extend its schema with `mode`, so the rest of the tool
    // contract the model sees cannot drift from the built-in one.
    const baseBash = createBashToolDefinition(process.cwd());

    const description =
        baseBash.description +
        ` Background mode runs the command asynchronously and returns immediately. ` +
        `Its stdout/stderr remains observable while it runs, and its final status and output are delivered back to the agent when it finishes.`;

    const parameters = Type.Object({
        ...baseBash.parameters.properties,
        mode: Type.Optional(
            Type.Union([
                Type.Literal("foreground"),
                Type.Literal("background"),
            ], {
                description:
                    `"foreground" waits for completion. ` +
                    `"background" returns immediately while the command continues running independently.`,
                default: "foreground",
            }),
        )
    });

    return defineTool({
        ...baseBash,
        description,
        parameters,

        promptSnippet:
            "Run shell commands in foreground or background; background commands keep running independently and remain observable.",
        promptGuidelines: [
            "Use foreground mode when subsequent work depends on the command result before continuing.",
            "Use background mode for independent long-running work so you can continue with other useful work while it runs.",
            "When creating long-running scripts or commands, make them observable with meaningful periodic progress output when practical, such as tqdm progress, stage logs, counters, or epoch updates.",
            "Do not keep a command in foreground only to wait for its final result when the work can safely run independently; background commands report their final status and output back to the agent when they finish.",
        ],

        renderCall(args, theme, context) {
            if ((args.mode ?? "foreground") === "background") {
                return new Container();
            }
            return baseBash.renderCall!(args, theme, context);
        },

        renderResult(result, options, theme, context) {
            if ((context.args.mode ?? "foreground") === "background") {
                return new Container();
            }
            return baseBash.renderResult!(result as Parameters<NonNullable<typeof baseBash.renderResult>>[0], options, theme, context);
        },

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            // Foreground is the default: delegate the call unchanged. The dock only tracks
            // background shells, so a foreground call must not touch the manager.
            if ((params.mode ?? "foreground") === "foreground") {
                // The built-in tool binds its cwd at construction time, and ctx.cwd can differ from
                // process.cwd(); rebuild it per call.
                const builtInBash = createBashTool(ctx.cwd);
                return builtInBash.execute(
                    toolCallId,
                    params,
                    signal,
                    onUpdate,
                );
            }

            // Background returns at once; the detached execution settles the job later.
            return startBackgroundShell(
                toolCallId,
                params.command,
                params.timeout,
                ctx
            );

        },
    });
}

const backgroundJobsSchema = Type.Object({
    jobs: Type.Optional(
        Type.Array(
            Type.Object({
                jobID: Type.String({
                    description: "Background shell ID to inspect.",
                }),
                includeOutput: Type.Optional(
                    Type.Boolean({
                        description:
                            "Include the shell's output as it currently shows on its terminal screen.",
                        default: false,
                    }),
                ),
            }),
            {
                description:
                    "Background shells to inspect. Omit the parameter or pass an empty array to list every shell instead.",
            },
        ),
    ),
});

/** Text-only result, the response shape of every `background_shell` branch. */
function backgroundShellText(text: string): AgentToolResult {
    return {
        content: [{ type: "text" as const, text }],
        details: undefined,
    };
}

/** One job summary line, the shape both the list and the inspect path report. */
function formatJobLine(job: Readonly<ShellJob>): string {
    return `${job.id}: ${job.status} - ${job.command}`;
}

/**
 * The job's output as its terminal screen - the same text `/shell` shows.
 *
 * The raw stream is a VT instruction sequence (`\r` redraws, SGR colour, erase-line), which is
 * noise in a model context, so the screen is what gets reported. xterm parses queued writes on a
 * later tick, which is why a read issued right after `appendOutput` would still see the previous
 * screen: writing an empty chunk first flushes through that same queue.
 */
async function readJobScreen(job: Readonly<ShellJob>): Promise<string[]> {
    await new Promise<void>((resolve) => job.terminal.write("", () => resolve()));
    return shellManager.getScreenLines(job.id);
}

/**
 * Build the `background_shell` tool definition.
 *
 * This is the only pull path to a detached job: a background `bash` call returns before its command
 * printed anything and its transcript row is suppressed, so until the job settles this tool is how
 * the model learns whether it still runs and what it printed so far. State comes from the shared
 * `shellManager` singleton - the same jobs the dock and `/shell` read - and never from a chat
 * transcript.
 *
 * Output is opt-in per job because a screen can hold up to pi's output tail limit; listing statuses
 * is cheap, while every requested screen is charged to the model's context.
 */
export function BackgroundShellTool() {
    return defineTool({
        name: "background_shell",
        label: "Background Shell",
        description:
            "List background shells, or inspect selected background shells and optionally read their current output.",
        parameters: backgroundJobsSchema,

        promptSnippet:
            "Check background shells started by bash mode=background: their status and current output.",
        promptGuidelines: [
            "Use background_shell when you need the current status or intermediate output of a background command before its completion notification arrives.",
            "When checking multiple background shells, query them together in one call when practical; request output only for shells whose output you actually need.",
        ],

        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            // Omitted and empty `jobs` mean the same thing: list every shell.
            const jobs = params.jobs ?? [];
            if (jobs.length === 0) {
                const allJobs = shellManager.getAllJobsList();
                if (allJobs.length === 0) {
                    return backgroundShellText("No background shells.");
                }
                return backgroundShellText(allJobs.map(formatJobLine).join("\n"));
            }

            // One block per requested shell, in the order asked for. An unknown id is answered
            // inline instead of thrown, so one stale id cannot fail the whole query.
            const blocks = await Promise.all(
                jobs.map(async (job) => {
                    const jobInfo = shellManager.getJob(job.jobID);
                    if (!jobInfo) {
                        return `Unknown background shell: ${job.jobID}`;
                    }

                    const line = formatJobLine(jobInfo);
                    if (job.includeOutput !== true) {
                        return line;
                    }

                    const screen = await readJobScreen(jobInfo);
                    return screen.length === 0
                        ? `${line}\n(no output yet)`
                        : `${line}\n${screen.join("\n")}`;
                }),
            );

            return backgroundShellText(blocks.join("\n\n"));
        },
    });
}

