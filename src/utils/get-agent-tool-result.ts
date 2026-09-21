import { type AgentToolResult } from "@earendil-works/pi-coding-agent";

/**
 * Concatenates text blocks from pi agent tool result into a single string.
 * 
 * @param agentToolResult - The {@link AgentToolResult} to read text from.
 * @returns The joined text, or an empty string if no text blocks exist.
 */
export function getAgentToolTextResult(agentToolResult: AgentToolResult) {
    return agentToolResult.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
}