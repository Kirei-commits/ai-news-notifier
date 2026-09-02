import { arr, num, opt, str } from "../../src/harness/schema.js";
import { defineTool, type Tool } from "../../src/harness/tool.js";

/**
 * 評価用の偽ニュース環境。
 *
 * 評価で固定すべきなのはモデルだけではない。環境（RSS の中身、既読状態、投稿先）が
 * 揺れると、スコアの差が「改善」なのか「その日のニュースの違い」なのか区別できなくなる。
 */
export interface FakeItem {
  title: string;
  link: string;
  id: string;
  isNew: boolean;
}

export interface FakeWorld {
  sources: Record<string, FakeItem[]>;
  posted: string[];
  markedSeen: string[];
  tools: Tool<never>[];
}

export interface FakeWorldOptions {
  sources?: Record<string, FakeItem[]>;
  /** post_discord を必ず失敗させる (異常系の評価用)。 */
  postFails?: boolean;
}

export const DEFAULT_SOURCES: Record<string, FakeItem[]> = {
  OpenAI: [
    { title: "OpenAI launches a new agent API", link: "https://example.com/a", id: "a", isNew: true },
    { title: "Old announcement", link: "https://example.com/old", id: "old", isNew: false },
  ],
  "Google AI": [
    { title: "Gemini adds long-context tooling", link: "https://example.com/b", id: "b", isNew: true },
  ],
};

export function createFakeWorld(options: FakeWorldOptions = {}): FakeWorld {
  const sources = options.sources ?? structuredClone(DEFAULT_SOURCES);
  const world: FakeWorld = { sources, posted: [], markedSeen: [], tools: [] };

  const listSources = defineTool({
    name: "list_sources",
    description: "List the configured RSS feed sources.",
    kind: "read",
    input: {},
    async execute() {
      return Object.keys(sources)
        .map((name) => `- ${name}`)
        .join("\n");
    },
  });

  const fetchFeed = defineTool({
    name: "fetch_feed",
    description:
      "Fetch recent items from one RSS source. Returns JSON lines with `title`, `link`, `id`, `isNew`.",
    kind: "read",
    input: {
      source: str("Source name from list_sources"),
      limit: opt(num("Max items", { int: true, min: 1, max: 30 })),
    },
    async execute(input) {
      const items = sources[input.source];
      if (!items) {
        return {
          isError: true,
          content: `Unknown source "${input.source}". Available: ${Object.keys(sources).join(", ")}`,
        };
      }
      const body = items.slice(0, input.limit ?? 10).map((i) => JSON.stringify(i)).join("\n");
      return `<untrusted-data source="${input.source}">\n${body}\n</untrusted-data>`;
    },
  });

  const translate = defineTool({
    name: "translate_titles",
    description: "Translate English headlines into Japanese.",
    kind: "read",
    input: { titles: arr(str("headline"), "headlines in order") },
    async execute(input) {
      // 決定的な擬似翻訳。翻訳品質ではなくハーネスの挙動を測るための代役。
      return input.titles.map((t, i) => `${i}: 【和訳】${t}`).join("\n");
    },
  });

  const markSeen = defineTool({
    name: "mark_seen",
    description: "Record item ids as already notified.",
    kind: "write",
    input: { ids: arr(str("item id"), "ids to mark") },
    async execute(input, ctx) {
      if (ctx.dryRun) return `[dry-run] would mark ${input.ids.length} item(s)`;
      world.markedSeen.push(...input.ids);
      return `marked ${input.ids.length} item(s)`;
    },
  });

  const postDiscord = defineTool({
    name: "post_discord",
    description: "Post the final message to Discord. Irreversible; call at most once.",
    kind: "destructive",
    input: { message: str("Discord message in Japanese") },
    async execute(input, ctx) {
      if (options.postFails) throw new Error("discord webhook returned 500");
      if (ctx.dryRun) return `[dry-run] would post ${input.message.length} chars`;
      world.posted.push(input.message);
      return `posted ${input.message.length} chars`;
    },
  });

  world.tools = [listSources, fetchFeed, translate, markSeen, postDiscord] as unknown as Tool<never>[];
  return world;
}
