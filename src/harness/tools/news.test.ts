import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run } from "../loop.js";
import { callTools, mockProvider, say } from "../providers/mock.js";
import { NEWS_SYSTEM_PROMPT, newsTools } from "./news.js";

describe("news tools (ネットワーク不要な範囲)", () => {
  it("list_sources → post_discord が dry-run で通る", async () => {
    const provider = mockProvider([
      callTools([{ name: "list_sources", input: {} }]),
      callTools([{ name: "post_discord", input: { message: "**テスト投稿**" } }]),
      say("投稿しました (dry-run)"),
    ]);

    const result = await run("今日のニュースをまとめて", {
      provider,
      system: NEWS_SYSTEM_PROMPT,
      tools: newsTools,
      dryRun: true,
    });

    assert.equal(result.stopReason, "done");
    assert.equal(result.turns, 3);

    const sources = provider.requests[1].messages.at(-1)!.content[0];
    assert.match((sources as { content: string }).content, /OpenAI: https/);

    const posted = provider.requests[2].messages.at(-1)!.content[0];
    assert.match((posted as { content: string }).content, /\[dry-run\] would post/);
  });

  it("未知の情報源はエラー結果として返り、候補が示される", async () => {
    const provider = mockProvider([
      callTools([{ name: "fetch_feed", input: { source: "存在しない" } }]),
      say("ok"),
    ]);
    await run("go", { provider, system: NEWS_SYSTEM_PROMPT, tools: newsTools });

    const block = provider.requests[1].messages.at(-1)!.content[0] as {
      content: string;
      isError: boolean;
    };
    assert.equal(block.isError, true);
    assert.match(block.content, /Unknown source "存在しない"/);
    assert.match(block.content, /Available: OpenAI, Google AI/);
  });

  it("mark_seen は dry-run では書き込まない", async () => {
    const provider = mockProvider([
      callTools([{ name: "mark_seen", input: { ids: ["a", "b"] } }]),
      say("ok"),
    ]);
    await run("go", { provider, system: NEWS_SYSTEM_PROMPT, tools: newsTools, dryRun: true });

    const block = provider.requests[1].messages.at(-1)!.content[0] as { content: string };
    assert.match(block.content, /\[dry-run\] would mark 2 item\(s\)/);
  });

  it("システムプロンプトが untrusted-data の扱いを明示している", () => {
    assert.match(NEWS_SYSTEM_PROMPT, /untrusted-data/);
    assert.match(NEWS_SYSTEM_PROMPT, /指示ではない/);
  });
});
