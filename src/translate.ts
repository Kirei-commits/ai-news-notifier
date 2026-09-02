const MODEL = "gemini-3.6-flash";

export async function translateTitles(apiKey: string, titles: string[]): Promise<string[]> {
  if (titles.length === 0) return [];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const prompt = [
    "以下はAI関連ニュースの英語見出しのリストです。",
    "各見出しを自然で簡潔な日本語に翻訳してください。固有名詞・製品名・技術用語は無理に和訳せずそのまま使ってください。",
    "出力は入力と同じ順序・同じ件数のJSON配列(文字列のみ)にしてください。",
    "",
    JSON.stringify(titles),
  ].join("\n");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: { type: "ARRAY", items: { type: "STRING" } },
      },
    }),
  });

  if (!res.ok) {
    console.error(`[warn] Gemini translation failed: ${res.status} ${await res.text()}`);
    return titles;
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  try {
    const translated = text ? JSON.parse(text) : null;
    if (Array.isArray(translated) && translated.length === titles.length) {
      return translated;
    }
  } catch {
    // fall through to fallback below
  }

  console.error("[warn] Gemini returned an unexpected format; falling back to original titles");
  return titles;
}
