import { estimateCostUsd } from "../src/harness/cost.js";
import type { RunResult, RunStopReason } from "../src/harness/loop.js";
import type { HarnessEvent } from "../src/harness/trace.js";

export interface EvalContext {
  result: RunResult;
  events: HarnessEvent[];
  /** 実行されたツール呼び出し (拒否されたものも含む)。 */
  toolCalls: { name: string; input: unknown }[];
  /** ツール結果 (エラーかどうか付き)。 */
  toolResults: { name: string; content: string; ok: boolean }[];
  model: string;
}

export interface AssertionResult {
  ok: boolean;
  label: string;
  detail?: string;
}

export type Assertion = (ctx: EvalContext) => AssertionResult;

export function calledTool(name: string, times?: number): Assertion {
  return (ctx) => {
    const count = ctx.toolResults.filter((t) => t.name === name).length;
    const ok = times === undefined ? count > 0 : count === times;
    return {
      ok,
      label: times === undefined ? `${name} を呼ぶ` : `${name} をちょうど ${times} 回呼ぶ`,
      detail: ok ? undefined : `実際: ${count} 回`,
    };
  };
}

export function didNotCallTool(name: string): Assertion {
  return (ctx) => {
    const count = ctx.toolResults.filter((t) => t.name === name).length;
    return {
      ok: count === 0,
      label: `${name} を呼ばない`,
      detail: count === 0 ? undefined : `実際: ${count} 回`,
    };
  };
}

export function stopReasonIs(expected: RunStopReason): Assertion {
  return (ctx) => ({
    ok: ctx.result.stopReason === expected,
    label: `stopReason が ${expected}`,
    detail: ctx.result.stopReason === expected ? undefined : `実際: ${ctx.result.stopReason}`,
  });
}

export function finishedWithin(maxTurns: number): Assertion {
  return (ctx) => ({
    ok: ctx.result.turns <= maxTurns,
    label: `${maxTurns} ターン以内に終わる`,
    detail: ctx.result.turns <= maxTurns ? undefined : `実際: ${ctx.result.turns} ターン`,
  });
}

export function outputMatches(pattern: RegExp): Assertion {
  return (ctx) => ({
    ok: pattern.test(ctx.result.text),
    label: `最終出力が ${pattern} にマッチ`,
    detail: pattern.test(ctx.result.text) ? undefined : `実際: ${ctx.result.text.slice(0, 120)}`,
  });
}

/** ツール結果の中身に対する検査。ハーネスがモデルに何を見せたかを固定できる。 */
export function toolResultMatches(name: string, pattern: RegExp): Assertion {
  return (ctx) => {
    const results = ctx.toolResults.filter((t) => t.name === name);
    const ok = results.some((r) => pattern.test(r.content));
    return {
      ok,
      label: `${name} の結果が ${pattern} を含む`,
      detail: ok ? undefined : `${results.length} 件中どれもマッチせず`,
    };
  };
}

export function noToolErrors(): Assertion {
  return (ctx) => {
    const failures = ctx.toolResults.filter((t) => !t.ok);
    return {
      ok: failures.length === 0,
      label: "ツールエラーが最終的に残らない",
      detail: failures.length === 0 ? undefined : failures.map((f) => f.name).join(", "),
    };
  };
}

/** エラーからの自己修復を測る: 一度失敗した後に同じツールが成功していること。 */
export function recoveredFrom(name: string): Assertion {
  return (ctx) => {
    const sequence = ctx.toolResults.filter((t) => t.name === name);
    const failedIndex = sequence.findIndex((t) => !t.ok);
    const ok = failedIndex >= 0 && sequence.slice(failedIndex + 1).some((t) => t.ok);
    return {
      ok,
      label: `${name} の失敗から自己修復する`,
      detail: ok ? undefined : `結果列: ${sequence.map((t) => (t.ok ? "ok" : "err")).join(",")}`,
    };
  };
}

export function costUnder(usd: number): Assertion {
  return (ctx) => {
    const cost = estimateCostUsd(ctx.result.usage, ctx.model);
    if (cost === null) return { ok: true, label: `コスト < $${usd}`, detail: "(単価不明のためスキップ)" };
    return {
      ok: cost < usd,
      label: `コスト < $${usd}`,
      detail: cost < usd ? undefined : `実際: $${cost.toFixed(4)}`,
    };
  };
}

/** 任意の検査を書くための逃げ道。 */
export function custom(label: string, check: (ctx: EvalContext) => boolean | string): Assertion {
  return (ctx) => {
    const outcome = check(ctx);
    return typeof outcome === "string"
      ? { ok: false, label, detail: outcome }
      : { ok: outcome, label };
  };
}
