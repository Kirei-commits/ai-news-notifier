import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translateTitles } from "./translate.js";

const geminiResponse = (payload: unknown) =>
  ({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
      }),
  }) as unknown as Response;

describe("translateTitles", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("空配列ならAPIを呼ばない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(translateTitles("key", [])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("翻訳結果を返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiResponse(["こんにちは", "世界"])));

    await expect(translateTitles("key", ["Hello", "World"])).resolves.toEqual([
      "こんにちは",
      "世界",
    ]);
  });

  it("API がエラーなら元の見出しを返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limited"),
      })
    );

    await expect(translateTitles("key", ["Hello"])).resolves.toEqual(["Hello"]);
  });

  it("件数が一致しなければ元の見出しを返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiResponse(["1件だけ"])));

    await expect(translateTitles("key", ["Hello", "World"])).resolves.toEqual(["Hello", "World"]);
  });

  it("文字列以外が混ざっていれば元の見出しを返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiResponse(["ok", 42])));

    await expect(translateTitles("key", ["Hello", "World"])).resolves.toEqual(["Hello", "World"]);
  });

  it("JSONとして壊れていれば元の見出しを返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }),
      })
    );

    await expect(translateTitles("key", ["Hello"])).resolves.toEqual(["Hello"]);
  });

  it("APIキーをURLに含めて呼び出す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiResponse(["やあ"]));
    vi.stubGlobal("fetch", fetchMock);

    await translateTitles("secret-key", ["Hi"]);

    expect(String(fetchMock.mock.calls[0][0])).toContain("key=secret-key");
  });
});
