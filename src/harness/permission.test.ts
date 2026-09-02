import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run } from "./loop.js";
import { defaultGate, policyGate, readOnly, type AskResolver } from "./permission.js";
import { callTools, mockProvider, say } from "./providers/mock.js";
import { str } from "./schema.js";
import { defineTool, type Tool } from "./tool.js";
import { memoryTracer } from "./trace.js";

let sideEffects: string[] = [];

const reader = defineTool({
  name: "reader",
  description: "read something",
  kind: "read",
  input: {},
  async execute() {
    return "data";
  },
});

const publish = defineTool({
  name: "publish",
  description: "publish something irreversible",
  kind: "destructive",
  input: { text: str("text") },
  async execute(input) {
    sideEffects.push(input.text);
    return "published";
  },
});

const tools = [reader, publish] as unknown as Tool<never>[];

function resultBlock(provider: ReturnType<typeof mockProvider>, requestIndex: number) {
  return provider.requests[requestIndex].messages.at(-1)!.content[0] as {
    content: string;
    isError: boolean;
  };
}

describe("permission gate", () => {
  it("readOnly は破壊的ツールを拒否し、read は通す", async () => {
    sideEffects = [];
    const provider = mockProvider([
      callTools([
        { name: "reader", input: {}, id: "a" },
        { name: "publish", input: { text: "x" }, id: "b" },
      ]),
      say("ok"),
    ]);
    await run("go", { provider, system: "s", tools, permission: readOnly });

    const blocks = provider.requests[1].messages.at(-1)!.content as {
      content: string;
      isError: boolean;
    }[];
    assert.equal(blocks[0].content, "data");
    assert.equal(blocks[1].isError, true);
    assert.match(blocks[1].content, /read-only/);
    assert.deepEqual(sideEffects, [], "拒否されたツールの副作用は起きない");
  });

  it("拒否されてもループは続き、モデルは理由を受け取る", async () => {
    const provider = mockProvider([
      callTools([{ name: "publish", input: { text: "x" } }]),
      say("投稿できなかったので報告します"),
    ]);
    const result = await run("go", { provider, system: "s", tools, permission: readOnly });

    assert.equal(result.stopReason, "done");
    assert.match(resultBlock(provider, 1).content, /Do not retry this call/);
  });

  it("maxCalls で同一ツールの連打を止める", async () => {
    sideEffects = [];
    const gate = policyGate({ maxCalls: { publish: 1 } });
    const provider = mockProvider([
      callTools([
        { name: "publish", input: { text: "1" }, id: "a" },
        { name: "publish", input: { text: "2" }, id: "b" },
      ]),
      say("ok"),
    ]);
    await run("go", { provider, system: "s", tools, permission: gate, dryRun: false });

    const blocks = provider.requests[1].messages.at(-1)!.content as { content: string }[];
    assert.equal(blocks[0].content, "published");
    assert.match(blocks[1].content, /at most 1 time\(s\)/);
    assert.deepEqual(sideEffects, ["1"], "2回目は実行されない");
  });

  it("ask は承認されれば実行される", async () => {
    sideEffects = [];
    const approve: AskResolver = async () => true;
    const provider = mockProvider([
      callTools([{ name: "publish", input: { text: "yes" } }]),
      say("ok"),
    ]);
    await run("go", {
      provider,
      system: "s",
      tools,
      permission: policyGate({ ask: ["destructive"] }),
      askResolver: approve,
      dryRun: false,
    });

    assert.deepEqual(sideEffects, ["yes"]);
  });

  it("ask は既定 (無人実行) では拒否される", async () => {
    sideEffects = [];
    const provider = mockProvider([
      callTools([{ name: "publish", input: { text: "no" } }]),
      say("ok"),
    ]);
    await run("go", {
      provider,
      system: "s",
      tools,
      permission: policyGate({ ask: ["destructive"] }),
      dryRun: false,
    });

    assert.deepEqual(sideEffects, [], "無人実行では ask は deny に落ちる");
  });

  it("defaultGate: dry-run では確認せず、実行モードでは確認する", async () => {
    let asked = 0;
    const askResolver: AskResolver = async () => {
      asked += 1;
      return true;
    };
    const script = () => [callTools([{ name: "publish", input: { text: "t" } }]), say("ok")];

    sideEffects = [];
    await run("go", {
      provider: mockProvider(script()),
      system: "s",
      tools,
      permission: defaultGate(),
      askResolver,
      dryRun: true,
    });
    assert.equal(asked, 0, "dry-run 中は確認不要");

    await run("go", {
      provider: mockProvider(script()),
      system: "s",
      tools,
      permission: defaultGate(),
      askResolver,
      dryRun: false,
    });
    assert.equal(asked, 1, "実行モードでは確認する");
  });

  it("判定はトレースに残る", async () => {
    const tracer = memoryTracer();
    const provider = mockProvider([
      callTools([{ name: "publish", input: { text: "x" } }]),
      say("ok"),
    ]);
    await run("go", { provider, system: "s", tools, permission: readOnly, tracer });

    const event = tracer.events.find((e) => e.type === "permission");
    assert.ok(event && event.type === "permission");
    assert.equal(event.resolved, "deny");
    assert.match(event.reason!, /read-only/);
  });
});
