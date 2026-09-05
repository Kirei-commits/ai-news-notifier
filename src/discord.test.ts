import { afterEach, describe, expect, it, vi } from "vitest";
import { postToDiscord, splitIntoChunks } from "./discord.js";

describe("splitIntoChunks", () => {
  it("上限に収まるテキストは分割しない", () => {
    expect(splitIntoChunks("a\nb\nc", 100)).toEqual(["a\nb\nc"]);
  });

  it("空文字は空配列を返す", () => {
    expect(splitIntoChunks("", 100)).toEqual([]);
  });

  it("行の途中で切らずに上限で分割する", () => {
    const chunks = splitIntoChunks("aaaa\nbbbb\ncccc", 10);
    expect(chunks).toEqual(["aaaa\nbbbb", "cccc"]);
  });

  it("1行が上限を超える場合も必ず上限以下に収める", () => {
    const chunks = splitIntoChunks("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(10);
  });

  it("どの入力でも全チャンクが上限以下になる", () => {
    const text = ["short", "y".repeat(50), "also short", "z".repeat(31)].join("\n");
    for (const chunk of splitIntoChunks(text, 20)) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("postToDiscord", () => {
  afterEach(() => vi.unstubAllGlobals());

  const okResponse = () => ({ ok: true, status: 204 }) as Response;

  it("チャンクごとにWebhookへPOSTする", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await postToDiscord("https://example.test/hook", "aaaa\nbbbb\ncccc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/hook");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ content: "aaaa\nbbbb\ncccc" });
  });

  it("429を受けたらretry_after待機後に再送する", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ retry_after: 0.01 }),
      })
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const promise = postToDiscord("https://example.test/hook", "hello");
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("その他のエラー応答では例外を投げる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      })
    );

    await expect(postToDiscord("https://example.test/hook", "hello")).rejects.toThrow(
      /Discord webhook failed: 500/
    );
  });
});
