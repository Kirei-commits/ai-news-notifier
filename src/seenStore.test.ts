import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

const fs = await import("node:fs/promises");
const { loadSeen, saveSeen } = await import("./seenStore.js");

const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
const mkdir = vi.mocked(fs.mkdir);

describe("loadSeen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("保存済みIDを読み込む", async () => {
    readFile.mockResolvedValue(JSON.stringify(["a", "b"]));
    await expect(loadSeen()).resolves.toEqual(new Set(["a", "b"]));
  });

  it("ファイルが無ければ空のSetを返す", async () => {
    readFile.mockRejectedValue(new Error("ENOENT"));
    await expect(loadSeen()).resolves.toEqual(new Set());
  });

  it("JSONが壊れていれば空のSetを返す", async () => {
    readFile.mockResolvedValue("not json");
    await expect(loadSeen()).resolves.toEqual(new Set());
  });

  it("配列でなければ空のSetを返す", async () => {
    readFile.mockResolvedValue(JSON.stringify({ a: 1 }));
    await expect(loadSeen()).resolves.toEqual(new Set());
  });

  it("文字列以外の要素は無視する", async () => {
    readFile.mockResolvedValue(JSON.stringify(["a", 1, null, "b"]));
    await expect(loadSeen()).resolves.toEqual(new Set(["a", "b"]));
  });
});

describe("saveSeen", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("保存先ディレクトリを作成してから書き込む", async () => {
    await saveSeen(new Set(["a"]));
    expect(mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("直近1000件までに切り詰める", async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `id-${i}`);
    await saveSeen(new Set(ids));

    const written = JSON.parse(writeFile.mock.calls[0][1] as string) as string[];
    expect(written).toHaveLength(1000);
    expect(written[0]).toBe("id-200");
    expect(written.at(-1)).toBe("id-1199");
  });
});
