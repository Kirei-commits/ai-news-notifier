import "dotenv/config";
import Parser from "rss-parser";
import { FEED_SOURCES } from "./sources.js";
import { loadSeen, saveSeen } from "./seenStore.js";
import { postToDiscord } from "./discord.js";
import { translateTitles } from "./translate.js";

const MAX_ITEMS_PER_SOURCE = 20;

interface NewsItem {
  source: string;
  title: string;
  link: string;
  id: string;
}

async function fetchAllFeeds(): Promise<NewsItem[]> {
  const parser = new Parser();
  const results = await Promise.allSettled(
    FEED_SOURCES.map(async (source) => {
      const feed = await parser.parseURL(source.url);
      return (feed.items ?? []).slice(0, MAX_ITEMS_PER_SOURCE).map((item) => ({
        source: source.name,
        title: item.title ?? "(no title)",
        link: item.link ?? "",
        id: item.guid ?? item.link ?? `${source.name}:${item.title}`,
      }));
    })
  );

  const items: NewsItem[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      console.error(`[warn] failed to fetch ${FEED_SOURCES[i].name}: ${result.reason}`);
    }
  }
  return items;
}

function formatMessage(items: NewsItem[]): string {
  const grouped = new Map<string, NewsItem[]>();
  for (const item of items) {
    if (!grouped.has(item.source)) grouped.set(item.source, []);
    grouped.get(item.source)!.push(item);
  }

  const lines = [`**🤖 AI最新情報 (${items.length}件)**`, ""];
  for (const [source, sourceItems] of grouped) {
    lines.push(`**${source}**`);
    for (const item of sourceItems) {
      lines.push(`- [${item.title}](${item.link})`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URL is not set. Copy .env.example to .env and fill it in.");
  }
  const geminiApiKey = process.env.GEMINI_API_KEY;

  const seen = await loadSeen();
  const allItems = await fetchAllFeeds();
  const newItems = allItems.filter((item) => !seen.has(item.id));

  if (newItems.length === 0) {
    console.log("No new items.");
    return;
  }

  if (geminiApiKey) {
    const translated = await translateTitles(
      geminiApiKey,
      newItems.map((item) => item.title)
    );
    newItems.forEach((item, i) => (item.title = translated[i]));
  } else {
    console.warn("[warn] GEMINI_API_KEY is not set; posting original (English) titles.");
  }

  await postToDiscord(webhookUrl, formatMessage(newItems));

  for (const item of newItems) seen.add(item.id);
  await saveSeen(seen);

  console.log(`Posted ${newItems.length} new item(s) to Discord.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
