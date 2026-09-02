import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffDelay, HttpError, isRetryableError, parseRetryAfter, withRetry } from "./retry.js";

const noSleep = async () => {};

describe("retry", () => {
  it("再試行して成功する", async () => {
    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new HttpError(503, "unavailable");
        return "ok";
      },
      { sleep: noSleep }
    );
    assert.equal(value, "ok");
    assert.equal(attempts, 3);
  });

  it("再試行しても意味のない失敗は即座に投げる", async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => {
          attempts += 1;
          throw new HttpError(400, "bad request");
        },
        { sleep: noSleep }
      ),
      /bad request/
    );
    assert.equal(attempts, 1, "400 は再試行しない");
  });

  it("回数を使い切ったら最後のエラーを投げる", async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => {
          attempts += 1;
          throw new HttpError(429, "rate limited");
        },
        { retries: 2, sleep: noSleep }
      ),
      /rate limited/
    );
    assert.equal(attempts, 3, "初回 + 2回の再試行");
  });

  it("retry-after があればバックオフより優先する", async () => {
    const delays: number[] = [];
    let attempts = 0;
    await withRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new HttpError(429, "slow down", 7000);
        return "ok";
      },
      { sleep: async (ms) => void delays.push(ms), baseMs: 10 }
    );
    assert.deepEqual(delays, [7000]);
  });

  it("バックオフは指数的に増え、ジッタで散る", () => {
    // random=1 で上限値、random=0 で 0。full jitter の範囲を確認する。
    assert.equal(backoffDelay(1, { baseMs: 100, random: () => 1 }), 100);
    assert.equal(backoffDelay(2, { baseMs: 100, random: () => 1 }), 200);
    assert.equal(backoffDelay(3, { baseMs: 100, random: () => 1 }), 400);
    assert.equal(backoffDelay(9, { baseMs: 100, maxMs: 1000, random: () => 1 }), 1000);
    assert.equal(backoffDelay(3, { baseMs: 100, random: () => 0 }), 0);
  });

  it("abort されたら再試行しない", async () => {
    const controller = new AbortController();
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => {
          attempts += 1;
          controller.abort();
          throw new HttpError(503, "unavailable");
        },
        { signal: controller.signal, sleep: noSleep }
      )
    );
    assert.equal(attempts, 1);
  });

  it("再試行対象の判定", () => {
    assert.equal(isRetryableError(new HttpError(429, "x")), true);
    assert.equal(isRetryableError(new HttpError(500, "x")), true);
    assert.equal(isRetryableError(new HttpError(404, "x")), false);
    assert.equal(isRetryableError(new TypeError("fetch failed")), true);
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    assert.equal(isRetryableError(aborted), false);
  });

  it("Retry-After を秒でも日付でも解釈する", () => {
    assert.equal(parseRetryAfter("3"), 3000);
    const now = Date.parse("2026-01-01T00:00:00Z");
    assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now), 5000);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter("garbage"), undefined);
  });
});
