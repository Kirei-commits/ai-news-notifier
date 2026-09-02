import { obj, SchemaError, type InferObject, type ObjectShape, type Schema } from "./schema.js";
import type { ToolSpec } from "./types.js";

/**
 * ツールの副作用の強さ。Phase 4 の権限ゲートがこれを見て判断する。
 * - read:        読み取りのみ。何度呼んでも安全。
 * - write:       状態を変えるが冪等・可逆。
 * - destructive: 外部に不可逆な影響を出す (Discord への投稿など)。
 */
export type ToolKind = "read" | "write" | "destructive";

export interface ToolContext {
  runId: string;
  signal?: AbortSignal;
  /** dry-run 中は副作用を起こさず、起こす予定の内容を返す。 */
  dryRun: boolean;
  log(message: string): void;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
  /** トレースにだけ残したい補足情報。モデルには渡らない。 */
  meta?: Record<string, unknown>;
}

export interface Tool<T = unknown> {
  name: string;
  description: string;
  kind: ToolKind;
  inputSchema: Schema<T>;
  spec: ToolSpec;
  execute(input: T, ctx: ToolContext): Promise<string | ToolOutput>;
}

export interface ToolDefinition<S extends ObjectShape> {
  name: string;
  /**
   * 説明はプロンプトの一部。「何をするか」だけでなく
   * 「いつ使うか / いつ使わないか」を書くと誤用が激減する。
   */
  description: string;
  kind: ToolKind;
  input: S;
  execute(input: InferObject<S>, ctx: ToolContext): Promise<string | ToolOutput>;
}

export function defineTool<S extends ObjectShape>(def: ToolDefinition<S>): Tool<InferObject<S>> {
  const inputSchema = obj(def.input);
  return {
    name: def.name,
    description: def.description,
    kind: def.kind,
    inputSchema,
    spec: {
      name: def.name,
      description: def.description,
      inputSchema: inputSchema.jsonSchema,
    },
    execute: def.execute,
  };
}

/**
 * 検証エラーをモデル向けの文章に変換する。
 *
 * 「invalid input」ではモデルは直せない。何が悪くて何が正しいかを書くと
 * 次のターンでほぼ確実に自己修復する。エラーメッセージもプロンプト。
 */
export function formatValidationError(tool: Tool, err: unknown): string {
  const detail = err instanceof SchemaError ? err.message : String(err);
  const params = Object.keys(
    (tool.spec.inputSchema.properties ?? {}) as Record<string, unknown>
  ).join(", ");
  return [
    `Invalid input for tool "${tool.name}": ${detail}`,
    `Expected parameters: ${params}`,
    `Schema: ${JSON.stringify(tool.spec.inputSchema)}`,
    "Fix the arguments and call the tool again.",
  ].join("\n");
}

export function toolRegistry(tools: Tool<never>[]): Map<string, Tool<never>> {
  const map = new Map<string, Tool<never>>();
  for (const tool of tools) {
    if (map.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    map.set(tool.name, tool);
  }
  return map;
}
