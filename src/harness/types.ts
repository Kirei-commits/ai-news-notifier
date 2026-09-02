/**
 * ハーネスの内部表現。
 *
 * ここがプロバイダ非依存であることが最重要。Anthropic の形でも Gemini の形でもなく、
 * 「ハーネスが扱いたい形」を定義し、各プロバイダがそこへ変換する。
 * こうしておくとループ・ツール・トレース・評価がプロバイダを一切知らずに済む。
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError: boolean;
}

/**
 * ハーネスが意味を理解しないが、次のリクエストにそのまま戻す必要があるブロック。
 * Anthropic の thinking ブロック（署名付き）などがこれにあたる。
 *
 * 内部表現を「自分が理解できるものだけ」に絞ると、こういう不透明データを落として
 * API エラーになる。中身を知らないまま持ち回れる箱を最初から用意しておく。
 */
export interface OpaqueBlock {
  type: "opaque";
  provider: string;
  data: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | OpaqueBlock;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens: number;
}

/**
 * 停止理由。ループ制御はこれだけを見て分岐する。
 * プロバイダ固有の値をここに漏らさないこと。
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  /** デバッグ・リプレイ用の生レスポンス。ループ側では絶対に参照しない。 */
  raw?: unknown;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

// --- 小さなヘルパ ---

export function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

export function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function toolUsesOf(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
