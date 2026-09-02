import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run } from "./loop.js";
import { callTools, mockProvider, say } from "./providers/mock.js";
import { str } from "./schema.js";
import { defineSubagentTool } from "./subagent.js";
import { defineTool, type Tool } from "./tool.js";
import { memoryTracer } from "./trace.js";

const search = defineTool({
  name: "search",
  description: "search",
  kind: "read",
  input: { q: str("query") },
  async execute(input) {
    return `大量の検索結果 (${input.q}) `.repeat(50);
  },
});

describe("subagent", () => {
  it("親には結論だけが返り、中間のツール結果は渡らない", async () => {
    const child = mockProvider([
      callTools([{ name: "search", input: { q: "agent" } }]),
      callTools([{ name: "search", input: { q: "harness" } }]),
      say("結論: エージェントは3件見つかりました"),
    ]);
    const researcher = defineSubagentTool({
      name: "researcher",
      description: "Delegate open-ended research.",
      system: "You research things.",
      tools: [search] as unknown as Tool<never>[],
      provider: child,
    });

    const parent = mockProvider([
      callTools([{ name: "researcher", input: { task: "エージェントについて調べて" } }]),
      say("調査完了"),
    ]);
    const result = await run("調べて", {
      provider: parent,
      system: "親",
      tools: [researcher] as unknown as Tool<never>[],
    });

    const block = parent.requests[1].messages.at(-1)!.content[0] as { content: string };
    assert.equal(block.content, "結論: エージェントは3件見つかりました");
    assert.ok(!block.content.includes("大量の検索結果"), "中間結果は親に渡らない");
    assert.equal(result.stopReason, "done");
    assert.equal(result.turns, 2, "親は2ターンで終わる (子は3ターン回っている)");
  });

  it("子のターン数と usage は meta としてトレースに残る", async () => {
    const child = mockProvider([
      callTools([{ name: "search", input: { q: "x" } }]),
      { content: [{ type: "text", text: "結論" }], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } },
    ]);
    const researcher = defineSubagentTool({
      name: "researcher",
      description: "research",
      system: "s",
      tools: [search] as unknown as Tool<never>[],
      provider: child,
    });
    const tracer = memoryTracer();
    const parent = mockProvider([
      callTools([{ name: "researcher", input: { task: "t" } }]),
      say("ok"),
    ]);
    await run("go", {
      provider: parent,
      system: "親",
      tools: [researcher] as unknown as Tool<never>[],
      tracer,
    });

    const end = tracer.events.find((e) => e.type === "tool_end");
    assert.ok(end && end.type === "tool_end");
    assert.equal((end.meta as { turns: number }).turns, 2);
    assert.deepEqual((end.meta as { usage: unknown }).usage, { inputTokens: 100, outputTokens: 20 });
  });

  it("子がターン上限に達したら親に注意書きを付ける", async () => {
    const child = mockProvider(
      Array.from({ length: 5 }, () => callTools([{ name: "search", input: { q: "x" } }]))
    );
    const researcher = defineSubagentTool({
      name: "researcher",
      description: "research",
      system: "s",
      tools: [search] as unknown as Tool<never>[],
      provider: child,
      maxTurns: 2,
    });
    const parent = mockProvider([
      callTools([{ name: "researcher", input: { task: "t" } }]),
      say("ok"),
    ]);
    await run("go", {
      provider: parent,
      system: "親",
      tools: [researcher] as unknown as Tool<never>[],
    });

    const block = parent.requests[1].messages.at(-1)!.content[0] as { content: string };
    assert.match(block.content, /ターン上限に達した/);
  });

  it("子の失敗はエラー結果として親に返る", async () => {
    const researcher = defineSubagentTool({
      name: "researcher",
      description: "research",
      system: "s",
      tools: [],
      provider: mockProvider([]),
    });
    const parent = mockProvider([
      callTools([{ name: "researcher", input: { task: "t" } }]),
      say("ok"),
    ]);
    const result = await run("go", {
      provider: parent,
      system: "親",
      tools: [researcher] as unknown as Tool<never>[],
    });

    const block = parent.requests[1].messages.at(-1)!.content[0] as {
      content: string;
      isError: boolean;
    };
    assert.equal(block.isError, true);
    assert.match(block.content, /Subagent "researcher" failed/);
    assert.equal(result.stopReason, "done", "親のループは死なない");
  });
});
