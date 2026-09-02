import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { combineHooks, redactSecrets, type HarnessHooks } from "./hooks.js";
import { run } from "./loop.js";
import { callTools, mockProvider, say } from "./providers/mock.js";
import { str } from "./schema.js";
import { defineTool, type Tool } from "./tool.js";

const echo = defineTool({
  name: "echo",
  description: "echo",
  kind: "read",
  input: { text: str("text") },
  async execute(input) {
    return `echo: ${input.text}`;
  },
});
const tools = [echo] as unknown as Tool<never>[];

function scripted() {
  return mockProvider([callTools([{ name: "echo", input: { text: "original" } }]), say("ok")]);
}

describe("hooks", () => {
  it("beforeToolUse で入力を書き換えられる", async () => {
    const hooks: HarnessHooks = {
      beforeToolUse: ({ input }) => ({ input: { text: `${(input as { text: string }).text}+patched` } }),
    };
    const provider = scripted();
    await run("go", { provider, system: "s", tools, hooks });

    const block = provider.requests[1].messages.at(-1)!.content[0] as { content: string };
    assert.equal(block.content, "echo: original+patched");
  });

  it("書き換えた入力も再検証される", async () => {
    const hooks: HarnessHooks = { beforeToolUse: () => ({ input: { text: 123 } }) };
    const provider = scripted();
    await run("go", { provider, system: "s", tools, hooks });

    const block = provider.requests[1].messages.at(-1)!.content[0] as {
      content: string;
      isError: boolean;
    };
    assert.equal(block.isError, true);
    assert.match(block.content, /text: expected string/);
  });

  it("afterToolUse で出力を加工できる", async () => {
    const hooks: HarnessHooks = { afterToolUse: () => ({ content: "REWRITTEN" }) };
    const provider = scripted();
    await run("go", { provider, system: "s", tools, hooks });

    const block = provider.requests[1].messages.at(-1)!.content[0] as { content: string };
    assert.equal(block.content, "REWRITTEN");
  });

  it("redactSecrets はツール出力から秘密を落とす", async () => {
    const secret = "https://discord.com/api/webhooks/SUPERSECRETVALUE";
    const leaky = defineTool({
      name: "leaky",
      description: "leaks",
      kind: "read",
      input: {},
      async execute() {
        return `posting to ${secret} now`;
      },
    });
    const provider = mockProvider([callTools([{ name: "leaky", input: {} }]), say("ok")]);
    await run("go", {
      provider,
      system: "s",
      tools: [leaky] as unknown as Tool<never>[],
      hooks: redactSecrets([secret]),
    });

    const block = provider.requests[1].messages.at(-1)!.content[0] as { content: string };
    assert.equal(block.content, "posting to [REDACTED] now");
  });

  it("短すぎる値は置換対象にしない (出力が壊れるため)", async () => {
    const provider = scripted();
    await run("go", { provider, system: "s", tools, hooks: redactSecrets(["o", "abc"]) });

    const block = provider.requests[1].messages.at(-1)!.content[0] as { content: string };
    assert.equal(block.content, "echo: original");
  });

  it("combineHooks は順に適用される", async () => {
    const hooks = combineHooks(
      { afterToolUse: ({ output }) => ({ content: `${output.content}|1` }) },
      { afterToolUse: ({ output }) => ({ content: `${output.content}|2` }) }
    );
    const provider = scripted();
    await run("go", { provider, system: "s", tools, hooks });

    const block = provider.requests[1].messages.at(-1)!.content[0] as { content: string };
    assert.equal(block.content, "echo: original|1|2");
  });
});
