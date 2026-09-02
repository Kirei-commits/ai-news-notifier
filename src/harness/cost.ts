import type { Usage } from "./types.js";

/**
 * コスト会計。
 *
 * 「だいたい安いはず」で運用すると必ず事故る。usage は毎ターン返ってくる実測値なので、
 * 積算してトレースに残しておく。単価は変わるのでここは定期的に更新する前提の表。
 */
export interface Price {
  /** 100万入力トークンあたりのドル。 */
  inputPerMTok: number;
  /** 100万出力トークンあたりのドル。 */
  outputPerMTok: number;
}

export const PRICES: Record<string, Price> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

export function estimateCostUsd(usage: Usage, model: string): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (
    (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000
  );
}

export function formatUsage(usage: Usage, model: string): string {
  const cost = estimateCostUsd(usage, model);
  const base = `in ${usage.inputTokens.toLocaleString()} / out ${usage.outputTokens.toLocaleString()} tokens`;
  return cost === null ? base : `${base} (~$${cost.toFixed(4)})`;
}
