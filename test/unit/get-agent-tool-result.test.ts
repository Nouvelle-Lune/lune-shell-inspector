/**
 * Unit tests for `getAgentToolTextResult`.
 *
 * The extension uses this helper on both streamed `onUpdate` payloads and the final result to turn
 * pi's content blocks into the text the shell dock reports. The tests pin the reading rules: text
 * blocks only, in order, joined without a separator.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import { getAgentToolTextResult } from "../../src/utils/get-agent-tool-result.ts";

/** Minimal result carrying the given content blocks. */
function resultWith(content: AgentToolResult["content"]): AgentToolResult {
    return { content, details: undefined };
}

function text(text: string): AgentToolResult["content"][number] {
    return { type: "text", text };
}

function image(): AgentToolResult["content"][number] {
    return { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
}

describe("getAgentToolTextResult", () => {
    it("returns the single text block unchanged", () => {
        assert.equal(getAgentToolTextResult(resultWith([text("hello\n")])), "hello\n");
    });

    it("joins multiple text blocks in order without a separator", () => {
        // Contract: the helper concatenates text blocks verbatim; any separator or newline is part of
        // the blocks the tool produced.
        assert.equal(getAgentToolTextResult(resultWith([text("first"), text("second"), text("third")])), "firstsecondthird");
    });

    it("skips non-text blocks instead of rendering them", () => {
        // Contract: image blocks carry no text, so they contribute nothing and do not shift the order
        // of the surrounding text.
        assert.equal(getAgentToolTextResult(resultWith([image(), text("before"), image(), text("after")])), "beforeafter");
    });

    it("returns an empty string when there is no text", () => {
        assert.equal(getAgentToolTextResult(resultWith([])), "");
        assert.equal(getAgentToolTextResult(resultWith([image()])), "");
    });

    it("keeps empty text blocks without adding anything", () => {
        assert.equal(getAgentToolTextResult(resultWith([text(""), text("value"), text("")])), "value");
    });

    it("does not modify the result it reads", () => {
        // Contract: the helper is a pure read; the same object is later handed to the caller of the
        // tool, so its blocks must survive unchanged.
        const content = [text("alpha"), image(), text("beta")];
        const result = resultWith(content);
        const before = structuredClone(result);

        getAgentToolTextResult(result);

        assert.deepEqual(result, before);
    });
});
