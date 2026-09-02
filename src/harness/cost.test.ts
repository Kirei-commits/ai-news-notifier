import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateCostUsd, formatUsage } from "./cost.js";

describe("cost", () => {
  it("既知モデルの概算コストを計算する", () => {
    const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 100_000 }, "claude-opus-5");
    assert.equal(cost, 5 + 2.5);
  });

  it("未知モデルは null を返す (でっち上げない)", () => {
    assert.equal(estimateCostUsd({ inputTokens: 1, outputTokens: 1 }, "unknown-model"), null);
    assert.equal(formatUsage({ inputTokens: 10, outputTokens: 2 }, "unknown-model"), "in 10 / out 2 tokens");
  });
});
