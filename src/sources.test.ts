import { describe, expect, it } from "vitest";
import { FEED_SOURCES } from "./sources.js";

describe("FEED_SOURCES", () => {
  it("空ではない", () => {
    expect(FEED_SOURCES.length).toBeGreaterThan(0);
  });

  it("すべて http(s) の解析可能なURLである", () => {
    for (const source of FEED_SOURCES) {
      const url = new URL(source.url);
      expect(["http:", "https:"]).toContain(url.protocol);
    }
  });

  it("名前が重複していない", () => {
    const names = FEED_SOURCES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("URLが重複していない", () => {
    const urls = FEED_SOURCES.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
