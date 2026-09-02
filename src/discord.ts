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

function splitIntoChunks(text: string, limit: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    if ((current + "\n" + line).length > limit) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
