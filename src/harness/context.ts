import type { ContentBlock, Message } from "./types.js";

/**
 * コンテキスト管理。
 *
 * 長く動くエージェントが壊れる一番の原因は「コンテキストが溢れる」ことで、
 * その中身のほとんどは過去のツール結果。つまり削るべき対象はほぼ決まっている。
 *
 * 絶対に守る制約: tool_use に対応する tool_result のブロックは消してはいけない。
 * ブロックごと落とすと API 側で対応が取れず 400 になる。中身だけ縮める。
 */

/**
 * トークン数の概算。
 * 正確な値は count_tokens API でしか得られないので、これは予算判断用の目安。
 * 日本語は 1 文字≒1トークンに近く、英語は 4 文字≒1トークンなので分けて数える。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code > 0x3000) cjk += 1;
  }
  const ascii = text.length - cjk;
  return Math.ceil(cjk + ascii / 4);
}

export function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          total += estimateTokens(block.text);
          break;
        case "tool_use":
          total += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input));
          break;
        case "tool_result":
          total += estimateTokens(block.content);
          break;
        case "opaque":
          total += estimateTokens(JSON.stringify(block.data));
          break;
      }
    }
    total += 4; // メッセージ枠のオーバーヘッド
  }
  return total;
}

export interface ContextEdit {
  /** 削減できた概算トークン数。 */
  savedTokens: number;
  /** 中身を縮めたツール結果の数。 */
  elidedResults: number;
}

export interface ContextStrategy {
  (messages: Message[]): { messages: Message[]; edit?: ContextEdit };
}

export const noCompaction: ContextStrategy = (messages) => ({ messages });

export interface ElideOptions {
  /** この概算トークン数を超えたら削り始める。 */
  maxTokens: number;
  /** 直近この数のツール結果は削らない (エージェントは直前の結果に依存して動く)。 */
  keepRecentResults?: number;
  /** 削った結果を置き換える文字列を作る。 */
  placeholder?: (block: { content: string }) => string;
}

/**
 * 古いツール結果から順に中身だけを置き換えていく戦略。
 *
 * 要約 (compaction) より安く、壊れにくい。まずこれを入れて、
 * それで足りない場合にだけ要約を検討する、という順番が実務的。
 */
export function elideOldToolResults(options: ElideOptions): ContextStrategy {
  const keepRecent = options.keepRecentResults ?? 2;
  const placeholder =
    options.placeholder ??
    ((block) => `[elided: ${block.content.length} chars of an earlier tool result]`);

  return (messages) => {
    let total = estimateMessageTokens(messages);
    if (total <= options.maxTokens) return { messages };

    // 削れる候補 = 古い順のツール結果 (直近 keepRecent 件は除く)
    const candidates: { messageIndex: number; blockIndex: number }[] = [];
    messages.forEach((message, messageIndex) => {
      message.content.forEach((block, blockIndex) => {
        if (block.type === "tool_result") candidates.push({ messageIndex, blockIndex });
      });
    });
    const editable = candidates.slice(0, Math.max(0, candidates.length - keepRecent));
    if (editable.length === 0) return { messages };

    const next = messages.map((m) => ({ role: m.role, content: [...m.content] }));
    let elidedResults = 0;
    const startTokens = total;

    for (const { messageIndex, blockIndex } of editable) {
      if (total <= options.maxTokens) break;
      const block = next[messageIndex].content[blockIndex] as Extract<
        ContentBlock,
        { type: "tool_result" }
      >;
      const replacement = placeholder(block);
      if (replacement.length >= block.content.length) continue;

      total -= estimateTokens(block.content) - estimateTokens(replacement);
      // ブロック自体は残す。消すと tool_use と対応が取れなくなる。
      next[messageIndex].content[blockIndex] = { ...block, content: replacement };
      elidedResults += 1;
    }

    if (elidedResults === 0) return { messages };
    return {
      messages: next,
      edit: { savedTokens: startTokens - total, elidedResults },
    };
  };
}
