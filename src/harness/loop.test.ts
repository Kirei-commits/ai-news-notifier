import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run } from "./loop.js";
import { callTools, mockProvider, say, stopWith } from "./providers/mock.js";
import { num, str } from "./schema.js";
import { defineTool, type Tool } from "./tool.js";
import { memoryTracer } from "./trace.js";
import type { Message } from "./types.js";

const echo = defineTool({
  name: "echo",
  description: "Echo back the given text.",
  kind: "read",
  input: { text: str("text to echo") },
  async execute(input) {
    return `echo: ${input.text}`;
  },
});

const add = defineTool({
  name: "add",
  description: "Add two numbers.",
  kind: "read",
  input: { a: num("left"), b: num("right") },
  async execute(input) {
    return String(input.a + input.b);
  },
});

const boom = defineTool({
  name: "boom",
  description: "Always throws.",
  kind: "read",
  input: {},
  async execute() {
    throw new Error("kaboom");
  },
});

const tools = [echo, add, boom] as unknown as Tool<never>[];

function baseConfig(script: Parameters<typeof mockProvider>[0], extra = {}) {
  return { provider: mockProvider(script), system: "sys", tools, ...extra };
}

describe("agent loop", () => {
  it("ツールを実行して結果を返し、次のターンで終了する", async () => {
    const provider = mockProvider([
      callTools([{ name: "echo", input: { text: "hi" } }]),
      say("done"),
    ]);
    const result = await run("go", { provider, system: "sys", tools });

    assert.equal(result.stopReason, "done");
    assert.equal(result.turns, 2);
    assert.equal(result.text, "done");

    const toolResults = provider.requests[1].messages.at(-1)!.content;
    assert.equal(toolResults.length, 1);
    assert.deepEqual(toolResults[0], {
      type: "tool_result",
      toolUseId: "call_0",
      content: "echo: hi",
      isError: false,
    });
  });

  it("並列ツール呼び出しの結果を 1 つの user メッセージにまとめる", async () => {
    const provider = mockProvider([
      callTools([
        { name: "echo", input: { text: "a" } },
        { name: "add", input: { a: 1, b: 2 } },
      ]),
      say("ok"),
    ]);
    const result = await run("go", { provider, system: "sys", tools });

    const userMessages = result.messages.filter((m: Message) => m.role === "user");
    assert.equal(userMessages.length, 2, "入力 + ツール結果 1 通のみであること");
    assert.equal(userMessages[1].content.length, 2);
    assert.deepEqual(
      userMessages[1].content.map((b) => (b.type === "tool_result" ? b.content : null)),
      ["echo: a", "3"]
    );
  });

  it("未知のツール名でも落ちずにエラー結果を返す", async () => {
    const provider = mockProvider([
      callTools([{ name: "nope", input: {} }]),
      say("recovered"),
    ]);
    const result = await run("go", { provider, system: "sys", tools });

    const block = provider.requests[1].messages.at(-1)!.content[0];
    assert.equal(block.type, "tool_result");
    assert.equal(block.isError, true);
    assert.match(block.content, /Unknown tool "nope"/);
    assert.match(block.content, /echo, add, boom/);
    assert.equal(result.stopReason, "done");
  });

  it("入力検証エラーは直し方つきでモデルに返る", async () => {
    const provider = mockProvider([
      callTools([{ name: "add", input: { a: 1 } }]),
      say("ok"),
    ]);
    await run("go", { provider, system: "sys", tools });

    const block = provider.requests[1].messages.at(-1)!.content[0];
    assert.equal(block.type === "tool_result" && block.isError, true);
    assert.match((block as { content: string }).content, /b: is required but missing/);
    assert.match((block as { content: string }).content, /Expected parameters: a, b/);
  });

  it("ツールが例外を投げてもループは止まらない", async () => {
    const provider = mockProvider([callTools([{ name: "boom", input: {} }]), say("ok")]);
    const result = await run("go", { provider, system: "sys", tools });

    const block = provider.requests[1].messages.at(-1)!.content[0];
    assert.match((block as { content: string }).content, /Tool "boom" failed: kaboom/);
    assert.equal(result.stopReason, "done");
  });

  it("maxTurns で打ち切る", async () => {
    const provider = mockProvider(
      Array.from({ length: 10 }, () => callTools([{ name: "echo", input: { text: "x" } }]))
    );
    const result = await run("go", { provider, system: "sys", tools, maxTurns: 3 });

    assert.equal(result.stopReason, "max_turns");
    assert.equal(result.turns, 3);
  });

  it("大きなツール出力を切り詰める", async () => {
    const big = defineTool({
      name: "big",
      description: "Returns a lot of text.",
      kind: "read",
      input: {},
      async execute() {
        return "x".repeat(5000);
      },
    });
    const provider = mockProvider([callTools([{ name: "big", input: {} }]), say("ok")]);
    await run("go", {
      provider,
      system: "sys",
      tools: [big] as unknown as Tool<never>[],
      maxToolResultChars: 100,
    });

    const block = provider.requests[1].messages.at(-1)!.content[0] as { content: string };
    assert.match(block.content, /truncated: 4900 of 5000 chars omitted/);
    assert.ok(block.content.length < 200);
  });

  it("プロバイダのエラーを stopReason=error として返す", async () => {
    const provider = mockProvider([]);
    const result = await run("go", { provider, system: "sys", tools });

    assert.equal(result.stopReason, "error");
    assert.match(result.error!.message, /script exhausted/);
  });

  it("abort されたら停止する", async () => {
    const controller = new AbortController();
    const provider = mockProvider([
      (): never => {
        controller.abort();
        throw new Error("aborted by test");
      },
    ]);
    const result = await run("go", {
      provider,
      system: "sys",
      tools,
      signal: controller.signal,
    });

    assert.equal(result.stopReason, "aborted");
  });

  it("refusal で即座に止まる", async () => {
    const provider = mockProvider([stopWith("refusal", "cannot help")]);
    const result = await run("go", { provider, system: "sys", tools });

    assert.equal(result.stopReason, "refusal");
    assert.equal(result.turns, 1);
  });

  it("トレースにツールの開始/終了が記録される", async () => {
    const tracer = memoryTracer();
    const provider = mockProvider([callTools([{ name: "echo", input: { text: "t" } }]), say("ok")]);
    await run("go", { provider, system: "sys", tools, tracer });

    const kinds = tracer.events.map((e) => e.type);
    assert.deepEqual(kinds, [
      "run_start",
      "turn_start",
      "model_request",
      "model_response",
      "tool_start",
      "tool_end",
      "turn_start",
      "model_request",
      "model_response",
      "run_end",
    ]);
  });

  it("ツールに渡る前に入力が正規化される (文字列の数値を受け入れる)", async () => {
    let received: unknown;
    const capture = defineTool({
      name: "capture",
      description: "capture",
      kind: "read",
      input: { a: num("a"), b: num("b") },
      async execute(input) {
        received = input;
        return "ok";
      },
    });
    const provider = mockProvider([
      callTools([{ name: "capture", input: { a: "1", b: 2 } }]),
      say("ok"),
    ]);
    await run("go", { provider, system: "sys", tools: [capture] as unknown as Tool<never>[] });

    assert.deepEqual(received, { a: 1, b: 2 });
  });

  it("baseConfig ヘルパは既定で dry-run", async () => {
    let dryRun: boolean | undefined;
    const probe = defineTool({
      name: "probe",
      description: "probe",
      kind: "destructive",
      input: {},
      async execute(_input, ctx) {
        dryRun = ctx.dryRun;
        return "ok";
      },
    });
    const config = baseConfig([callTools([{ name: "probe", input: {} }]), say("ok")], {
      tools: [probe] as unknown as Tool<never>[],
    });
    await run("go", config as never);

    assert.equal(dryRun, true, "副作用は既定で dry-run であるべき");
  });
});
