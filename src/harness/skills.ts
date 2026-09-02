import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { str } from "./schema.js";
import { defineTool, type AnyTool } from "./tool.js";

/**
 * スキル (段階的開示)。
 *
 * 知識を全部システムプロンプトに詰めると、毎ターン全額課金され、
 * その大半はそのタスクに関係がない。名前と一行説明だけを常時見せ、
 * 本文は必要になったときにモデル自身に読ませる。
 *
 * ハーネス側の仕事は「索引を作ること」と「読む手段を与えること」の 2 つだけ。
 */
export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export function parseSkill(source: string, path: string): { meta: Omit<SkillMeta, "path"> & { path: string }; body: string } {
  const match = FRONTMATTER.exec(source);
  if (!match) {
    throw new Error(`${path}: frontmatter (--- name / description ---) がありません`);
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  if (!fields.name || !fields.description) {
    throw new Error(`${path}: frontmatter に name と description が必要です`);
  }
  return {
    meta: { name: fields.name, description: fields.description, path },
    body: source.slice(match[0].length).trim(),
  };
}

export function loadSkills(dir = "skills"): SkillMeta[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const skills: SkillMeta[] = [];
  for (const entry of entries) {
    const path = join(dir, entry, "SKILL.md");
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    skills.push(parseSkill(readFileSync(path, "utf-8"), path).meta);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** システムプロンプトに埋め込む索引。本文は含めない。 */
export function renderSkillIndex(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";
  return [
    "# 利用可能なスキル",
    "必要になったら read_skill で本文を読むこと。最初から全部読む必要はない。",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}

export function readSkillTool(skills: SkillMeta[]): AnyTool {
  const tool = defineTool({
    name: "read_skill",
    description:
      "Read the full text of a skill by name. Call this when a listed skill is relevant to the current step.",
    kind: "read",
    input: { name: str("Skill name, exactly as listed in the system prompt") },
    async execute(input) {
      const skill = skills.find((s) => s.name === input.name);
      if (!skill) {
        return {
          isError: true,
          content: `Unknown skill "${input.name}". Available: ${skills.map((s) => s.name).join(", ") || "(none)"}`,
        };
      }
      return parseSkill(readFileSync(skill.path, "utf-8"), skill.path).body;
    },
  });
  return tool as unknown as AnyTool;
}
