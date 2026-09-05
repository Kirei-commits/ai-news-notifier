const DISCORD_LIMIT = 2000;

export async function postToDiscord(webhookUrl: string, content: string): Promise<void> {
  for (const chunk of splitIntoChunks(content, DISCORD_LIMIT)) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: chunk }),
    });

    if (res.status === 429) {
      const { retry_after } = (await res.json()) as { retry_after: number };
      await new Promise((r) => setTimeout(r, retry_after * 1000));
      await postToDiscord(webhookUrl, chunk);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
    }
  }
}

export function splitIntoChunks(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of text.split("\n")) {
    // 1行だけで上限を超える場合は行内で強制的に分割する
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }
    if (current && `${current}\n${line}`.length > limit) {
      flush();
    }
    current = current ? `${current}\n${line}` : line;
  }

  flush();
  return chunks;
}
