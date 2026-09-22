/**
 * Scripted (faux) provider for the subagent scenario of the real pi TUI observer.
 *
 * One offline session shows the shell dock and pi-subagents' own surface at the same time:
 *
 * 1. the parent's first scripted turn asks for two tool calls - a long background `bash` command
 *    (`mode: "background"`, so it becomes a dock job instead of holding the turn) and a foreground
 *    `subagent` call for the probe agent registered below, so the shell runs while the subagent does;
 * 2. the probe's scripted turns run a long `bash` command of their own and then report back;
 * 3. the parent's scripted closing line ends the fixture.
 *
 * The scripted responses are returned by one factory instead of a fixed queue: it identifies the
 * probe session by the marker in its system prompt, so the response order does not depend on how the
 * parent and the child interleave. No network is involved; `faux/faux-1` is the only model in play.
 *
 * Selection (all optional, no silent fallback):
 * - `PI_SHELL_VIEW_COMMAND` replaces the parent's shell command.
 * - `PI_SHELL_VIEW_PROBE_COMMAND` replaces the probe's shell command (foreground in the probe session).
 */
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
    type FauxResponseFactory,
    type Message,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Name the parent's scripted `subagent` call uses. */
const PROBE_AGENT_NAME = "pi-shell-view-probe";

/** Marker planted in the probe's system prompt so scripted responses can tell the sessions apart. */
const PROBE_MARKER = "PI-SHELL-VIEW-PROBE-MARKER";

const PROBE_SYSTEM_PROMPT = `You are ${PROBE_MARKER}, an offline probe subagent used by the pi-shell-view TUI observer. Run the task and report back in one line.`;

/** Closing texts, printed once each session's scripted turns are exhausted. */
const PARENT_FINAL_TEXT = "fixture finished";
const PROBE_FINAL_TEXT = "probe finished";

/** Shell commands the fixture runs when the environment does not override them. */
const DEFAULT_PARENT_COMMAND = "sleep 30";
const DEFAULT_PROBE_COMMAND = "sleep 25";

/**
 * Queue depth: a factory step is consumed per model request, and this scenario needs one parent
 * request plus two probe requests. Extra steps only make an unexpected extra turn survivable.
 */
const SCRIPTED_STEPS = 8;

/** Channel pi-subagents listens on to accept an agent from another extension. */
const RUNTIME_AGENT_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";

/** Request shape documented by pi-subagents; the owner writes `result` before `emit()` returns. */
interface RuntimeAgentRegistrationRequest {
    version: 1;
    name: string;
    definition: {
        description: string;
        systemPrompt: string;
        tools?: readonly string[];
        model?: string;
    };
    result?: { ok: true; registration: { dispose(): void } } | { ok: false; error: Error };
}

/** Read one observer variable, falling back to the scenario default. */
function commandFromEnv(name: string, fallback: string): string {
    const value = process.env[name];
    return value === undefined || value.trim() === "" ? fallback : value;
}

/** Text of a system message, whose content is either a string or text blocks. */
function systemText(message: Message): string {
    if (message.role !== "system") {
        return "";
    }
    if (typeof message.content === "string") {
        return message.content;
    }
    return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

export default function (pi: ExtensionAPI): void {
    const faux = fauxProvider();
    pi.registerProvider(faux.provider);

    const parentCommand = commandFromEnv("PI_SHELL_VIEW_COMMAND", DEFAULT_PARENT_COMMAND);
    const probeCommand = commandFromEnv("PI_SHELL_VIEW_PROBE_COMMAND", DEFAULT_PROBE_COMMAND);

    const parent = { turns: 0 };
    const probe = { turns: 0 };

    const scriptedResponse: FauxResponseFactory = (context) => {
        const isProbe = context.messages.some((message) => systemText(message).includes(PROBE_MARKER));

        if (isProbe) {
            probe.turns += 1;
            if (probe.turns === 1) {
                return fauxAssistantMessage(fauxToolCall("bash", { command: probeCommand }), { stopReason: "toolUse" });
            }
            return fauxAssistantMessage(PROBE_FINAL_TEXT);
        }

        parent.turns += 1;
        if (parent.turns === 1) {
            // Two sibling tool calls: the background shell returns immediately and becomes a dock job,
            // the foreground subagent keeps running, so both below-editor surfaces are on screen at
            // the same time.
            return fauxAssistantMessage(
                [
                    fauxToolCall("bash", { command: parentCommand, mode: "background" }),
                    fauxToolCall("subagent", { agent: PROBE_AGENT_NAME, task: "run the probe command and report back", async: false }),
                ],
                { stopReason: "toolUse" },
            );
        }
        return fauxAssistantMessage(PARENT_FINAL_TEXT);
    };

    faux.setResponses(Array.from({ length: SCRIPTED_STEPS }, () => scriptedResponse));

    let runtimeAgent: { dispose(): void } | undefined;

    pi.on("session_start", () => {
        const request: RuntimeAgentRegistrationRequest = {
            version: 1,
            name: PROBE_AGENT_NAME,
            definition: {
                description: "Offline probe subagent that runs one shell command",
                systemPrompt: PROBE_SYSTEM_PROMPT,
                tools: ["bash"],
                // The child must stay offline too, so it is pinned to the scripted provider instead of
                // inheriting whatever model the operator has selected.
                model: "faux/faux-1",
            },
        };

        pi.events.emit(RUNTIME_AGENT_REGISTER_EVENT, request);

        if (!request.result) {
            throw new Error(
                `pi-subagents did not handle ${RUNTIME_AGENT_REGISTER_EVENT}; load it with -e or the subagent scenario cannot run`,
            );
        }
        if (!request.result.ok) {
            throw request.result.error;
        }
        runtimeAgent = request.result.registration;
    });

    pi.on("session_shutdown", () => {
        runtimeAgent?.dispose();
        runtimeAgent = undefined;
    });
}
