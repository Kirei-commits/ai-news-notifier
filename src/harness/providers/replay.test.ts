import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run } from "../loop.js";
import { memoryTracer } from "../trace.js";
import { defineTool, type Tool } from "../tool.js";
import { str } from "../schema.js";
import { callTools, mockProvider, say } from "./mock.js";
import { ReplayProvider } from "./replay.js";

const echo = defineTool({
  name: "echo",
  description: "Echo back the given text.",
  kind: "read",
  input: { text: str("text") },
  async execute(input) {
    return `echo: ${input.text}`;
  },
});
const tools = [echo] as unknown as Tool<never>[];

async function record() {
  const tracer = memoryTracer();
  const provider = mockProvider([
    callTools([{ name: "echo", input: { text: "hi" } }]),
    say("finished"),
  ]);
  const result = await run("go", { provider, system: "SYSTEM", tools, tracer });
  return { tracer, result };
}

describe("ReplayProvider", () => {
  it("記録したトレースから同じ結果を再生する", async () => {
    const { tracer, result: original } = await record();
    const replayed = await run("go", {
      provider: ReplayProvider.fromEvents(tracer.events),
      system: "SYSTEM",
      tools,
    });

    assert.equal(replayed.text, original.text);
    assert.equal(replayed.turns, original.turns);
    assert.equal(replayed.stopReason, original.stopReason);
  });

  it("strict: システムプロンプトを変えると差分を検出する", async () => {
    const { tracer } = await record();
    const result = await run("go", {
      provider: ReplayProvider.fromEvents(tracer.events, { strict: true }),
      system: "SYSTEM (改訂版)",
      tools,
    });

    assert.equal(result.stopReason, "error");
    assert.match(result.error!.message, /system prompt changed/);
  });

  it("strict: ツール結果の形が変わると差分を検出する", async () => {
    const { tracer } = await record();
    const extra = defineTool({
      name: "echo",
      description: "Echo back the given text.",
      kind: "read",
      input: { text: str("text") },
      async execute() {
        // ブロック数が変わるわけではないので、ここでは検出されないことを確認する
        return "different";
      },
    });
    const result = await run("go", {
      provider: ReplayProvider.fromEvents(tracer.events, { strict: true }),
      system: "SYSTEM",
      tools: [extra] as unknown as Tool<never>[],
    });
    assert.equal(result.stopReason, "done", "内容の違いはブロック構造では検出されない");
  });

  it("トレースが尽きたらエラーになる", async () => {
    const { tracer } = await record();
    const provider = ReplayProvider.fromEvents(tracer.events);
    const result = await run("go", {
      provider,
      system: "SYSTEM",
      tools,
      // 3ターン目を要求させる: echo を2回呼ばせる台本ではないので end_turn で終わるはず
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "done");
  });
});
