import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run } from "./loop.js";
import { callTools, mockProvider, say } from "./providers/mock.js";
import { loadSkills, parseSkill, readSkillTool, renderSkillIndex } from "./skills.js";

describe("skills", () => {
  it("frontmatter を解析する", () => {
    const { meta, body } = parseSkill(
      "---\nname: demo\ndescription: デモ用\n---\n\n本文です\n",
      "x/SKILL.md"
    );
    assert.deepEqual(meta, { name: "demo", description: "デモ用", path: "x/SKILL.md" });
    assert.equal(body, "本文です");
  });

  it("frontmatter が無ければ失敗する", () => {
    assert.throws(() => parseSkill("本文だけ", "x/SKILL.md"), /frontmatter/);
  });

  it("リポジトリの skills/ を読み込める", () => {
    const skills = loadSkills();
    const digest = skills.find((s) => s.name === "discord-digest");
    assert.ok(digest, "discord-digest スキルが見つかること");
    assert.match(digest.description, /Discord/);
  });

  it("索引には説明だけが入り、本文は入らない", () => {
    const index = renderSkillIndex(loadSkills());
    assert.match(index, /- discord-digest:/);
    assert.ok(!index.includes("2000 文字"), "本文はシステムプロンプトに載せない");
  });

  it("read_skill が本文を返す", async () => {
    const skills = loadSkills();
    const provider = mockProvider([
      callTools([{ name: "read_skill", input: { name: "discord-digest" } }]),
      say("読みました"),
    ]);
    await run("go", { provider, system: "s", tools: [readSkillTool(skills)] });

    const block = provider.requests[1].messages.at(-1)!.content[0] as { content: string };
    assert.match(block.content, /1 メッセージは 2000 文字まで/);
  });

  it("未知のスキル名は候補つきのエラーになる", async () => {
    const skills = loadSkills();
    const provider = mockProvider([
      callTools([{ name: "read_skill", input: { name: "nope" } }]),
      say("ok"),
    ]);
    await run("go", { provider, system: "s", tools: [readSkillTool(skills)] });

    const block = provider.requests[1].messages.at(-1)!.content[0] as {
      content: string;
      isError: boolean;
    };
    assert.equal(block.isError, true);
    assert.match(block.content, /Unknown skill "nope"/);
    assert.match(block.content, /discord-digest/);
  });
});
