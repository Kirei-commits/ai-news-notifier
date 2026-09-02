import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { elideOldToolResults, estimateMessageTokens, estimateTokens } from "./context.js";
import { run } from "./loop.js";
import { callTools, mockProvider, say } from "./providers/mock.js";
import { defineTool, type Tool } from "./tool.js";
import { memoryTracer } from "./trace.js";
import type { Message } from "./types.js";

function toolResultMessage(id: string, content: string): Message {
  return { role: "user", content: [{ type: "tool_result", toolUseId: id, content, isError: false }] };
}

describe("context", () => {
  it("日本語と英語で概算トークン数を分けて数える", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("あいうえお"), 5);
  });

  it("予算内なら何もしない", () => {
    const messages = [toolResultMessage("a", "short")];
    const strategy = elideOldToolResults({ maxTokens: 10_000 });
    const result = strategy(messages);

    assert.equal(result.edit, undefined);
    assert.equal(result.messages, messages);
  });

  it("古いツール結果から順に中身だけ縮める", () => {
    const messages = [
      toolResultMessage("a", "x".repeat(4000)),
      toolResultMessage("b", "y".repeat(4000)),
      toolResultMessage("c", "z".repeat(4000)),
      toolResultMessage("d", "w".repeat(4000)),
    ];
    const before = estimateMessageTokens(messages);
    const result = elideOldToolResults({ maxTokens: 1500, keepRecentResults: 2 })(messages);

    assert.ok(result.edit);
    assert.ok(estimateMessageTokens(result.messages) < before);
    assert.match((result.messages[0].content[0] as { content: string }).content, /elided: 4000 chars/);
    // 直近2件は保護される
    assert.equal((result.messages[2].content[0] as { content: string }).content.length, 4000);
    assert.equal((result.messages[3].content[0] as { content: string }).content.length, 4000);
  });

  it("ツール結果のブロック自体は消さない (tool_use と対応が取れなくなるため)", () => {
    const messages = [toolResultMessage("a", "x".repeat(9000)), toolResultMessage("b", "y".repeat(9000))];
    const result = elideOldToolResults({ maxTokens: 10, keepRecentResults: 0 })(messages);

    assert.equal(result.messages.length, 2);
    for (const message of result.messages) {
      assert.equal(message.content.length, 1);
      assert.equal(message.content[0].type, "tool_result");
      assert.equal((message.content[0] as { toolUseId: string }).toolUseId.length > 0, true);
    }
  });

  it("元の messages を破壊しない", () => {
    const messages = [toolResultMessage("a", "x".repeat(5000)), toolResultMessage("b", "y")];
    elideOldToolResults({ maxTokens: 10, keepRecentResults: 0 })(messages);
    assert.equal((messages[0].content[0] as { content: string }).content.length, 5000);
  });

  it("ループに組み込むと圧縮が履歴に焼き込まれ、トレースに残る", async () => {
    const big = defineTool({
      name: "big",
      description: "big",
      kind: "read",
      input: {},
      async execute() {
        return "x".repeat(6000);
      },
    });
    const tracer = memoryTracer();
    const provider = mockProvider([
      callTools([{ name: "big", input: {} }], undefined),
      callTools([{ name: "big", input: {} }], undefined),
      callTools([{ name: "big", input: {} }], undefined),
      say("done"),
    ]);

    await run("go", {
      provider,
      system: "s",
      tools: [big] as unknown as Tool<never>[],
      tracer,
      contextStrategy: elideOldToolResults({ maxTokens: 2000, keepRecentResults: 1 }),
    });

    const edits = tracer.events.filter((e) => e.type === "context_edit");
    assert.ok(edits.length >= 1, "圧縮イベントが記録されること");

    // 最終リクエストに送られた古い結果は縮んでいる
    const lastRequest = provider.requests.at(-1)!;
    const contents = lastRequest.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
      .map((b) => (b as { content: string }).content);
    assert.ok(contents.some((c) => c.startsWith("[elided:")), "古い結果は圧縮済み");
    assert.ok(contents.some((c) => c.length > 1000), "直近の結果は残っている");
  });
});
