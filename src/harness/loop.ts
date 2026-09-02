import { formatValidationError, toolRegistry, type Tool, type ToolContext } from "./tool.js";
import { memoryTracer, type Tracer } from "./trace.js";
import {
  addUsage,
  textOf,
  toolUsesOf,
  userText,
  type ContentBlock,
  type Message,
  type Provider,
  type ToolResultBlock,
  type ToolUseBlock,
  type Usage,
} from "./types.js";

export type RunStopReason = "done" | "max_turns" | "aborted" | "refusal" | "error";

export interface RunConfig {
  provider: Provider;
  system: string;
  tools: Tool<never>[];
  /** 無限ループ防止。ハーネスに必須の安全装置。 */
  maxTurns?: number;
  maxOutputTokens?: number;
  /** 1 ツール結果あたりの上限文字数。コンテキスト枯渇の最大要因を抑える。 */
  maxToolResultChars?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  tracer?: Tracer;
  runId?: string;
}

export interface RunResult {
  runId: string;
  text: string;
  messages: Message[];
  stopReason: RunStopReason;
  turns: number;
  usage: Usage;
  tracer: Tracer;
  error?: Error;
}

const DEFAULTS = {
  maxTurns: 12,
  maxOutputTokens: 8192,
  maxToolResultChars: 8000,
};

export function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * エージェントループ本体。
 *
 * これがハーネスの心臓部で、実質これだけしかない:
 *   モデルを呼ぶ → tool_use が無ければ終了 → あれば全部実行して結果を 1 メッセージで返す → 繰り返す
 *
 * 難しいのはループそのものではなく、その周りの「壊れ方の面倒を見る」部分。
 */
export async function run(input: string | Message[], config: RunConfig): Promise<RunResult> {
  const maxTurns = config.maxTurns ?? DEFAULTS.maxTurns;
  const maxOutputTokens = config.maxOutputTokens ?? DEFAULTS.maxOutputTokens;
  const maxToolResultChars = config.maxToolResultChars ?? DEFAULTS.maxToolResultChars;
  const runId = config.runId ?? newRunId();
  const tracer = config.tracer ?? memoryTracer();
  const registry = toolRegistry(config.tools);
  const specs = config.tools.map((t) => t.spec);

  const messages: Message[] = typeof input === "string" ? [userText(input)] : [...input];
  const ctx: ToolContext = {
    runId,
    signal: config.signal,
    dryRun: config.dryRun ?? true,
    log: (message) => console.error(`[${runId}] ${message}`),
  };

  tracer.emit({
    type: "run_start",
    runId,
    at: new Date().toISOString(),
    provider: config.provider.name,
    model: config.provider.model,
    system: config.system,
    tools: config.tools.map((t) => t.name),
    input: messages,
  });

  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: RunStopReason = "max_turns";
  let error: Error | undefined;
  let turn = 0;

  while (turn < maxTurns) {
    if (config.signal?.aborted) {
      stopReason = "aborted";
      break;
    }
    turn += 1;
    tracer.emit({ type: "turn_start", turn });
    tracer.emit({ type: "model_request", turn, messages: structuredClone(messages) });

    let response;
    try {
      response = await config.provider.complete(
        { system: config.system, messages, tools: specs, maxOutputTokens },
        config.signal
      );
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      stopReason = config.signal?.aborted ? "aborted" : "error";
      break;
    }

    usage = addUsage(usage, response.usage);
    tracer.emit({
      type: "model_response",
      turn,
      stopReason: response.stopReason,
      usage: response.usage,
      content: response.content,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stopReason === "refusal") {
      stopReason = "refusal";
      break;
    }

    const toolUses = toolUsesOf(response.content);
    if (response.stopReason !== "tool_use" || toolUses.length === 0) {
      stopReason = "done";
      break;
    }

    // 並列に実行して、tool_use と同じ順序で結果を並べる。
    const results = await Promise.all(
      toolUses.map((use) => executeToolUse(use, registry, ctx, tracer, turn, maxToolResultChars))
    );

    // 重要: ツール結果は必ず 1 つの user メッセージにまとめる。
    // 分割して送るとモデルは並列ツール呼び出しをやめてしまう。
    messages.push({ role: "user", content: results });
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const text = lastAssistant ? textOf(lastAssistant.content) : "";

  tracer.emit({
    type: "run_end",
    stopReason,
    turns: turn,
    usage,
    text,
    error: error?.message,
  });

  return { runId, text, messages, stopReason, turns: turn, usage, tracer, error };
}

async function executeToolUse(
  use: ToolUseBlock,
  registry: Map<string, Tool<never>>,
  ctx: ToolContext,
  tracer: Tracer,
  turn: number,
  maxChars: number
): Promise<ToolResultBlock> {
  tracer.emit({ type: "tool_start", turn, toolUseId: use.id, name: use.name, input: use.input });
  const startedAt = Date.now();

  const finish = (content: string, isError: boolean, meta?: Record<string, unknown>): ToolResultBlock => {
    const truncated = truncate(content, maxChars);
    tracer.emit({
      type: "tool_end",
      turn,
      toolUseId: use.id,
      name: use.name,
      ok: !isError,
      durationMs: Date.now() - startedAt,
      content: truncated,
      meta,
    });
    return { type: "tool_result", toolUseId: use.id, content: truncated, isError };
  };

  const tool = registry.get(use.name);
  if (!tool) {
    // 未知のツール名でもプロセスは落とさない。モデルに直させる。
    return finish(
      `Unknown tool "${use.name}". Available tools: ${[...registry.keys()].join(", ")}`,
      true
    );
  }

  let parsed;
  try {
    parsed = tool.inputSchema.validate(use.input, "");
  } catch (err) {
    return finish(formatValidationError(tool, err), true);
  }

  try {
    const output = await tool.execute(parsed as never, ctx);
    if (typeof output === "string") return finish(output, false);
    return finish(output.content, output.isError ?? false, output.meta);
  } catch (err) {
    // ツールの例外はループを殺さない。モデルは失敗から回復できる。
    const message = err instanceof Error ? err.message : String(err);
    return finish(`Tool "${use.name}" failed: ${message}`, true);
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n…[truncated: ${omitted} of ${text.length} chars omitted]`;
}
