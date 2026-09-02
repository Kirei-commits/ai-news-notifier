import { estimateMessageTokens, noCompaction, type ContextStrategy } from "./context.js";
import type { HarnessHooks } from "./hooks.js";
import {
  allowAll,
  denyOnAsk,
  type AskResolver,
  type PermissionGate,
} from "./permission.js";
import { formatValidationError, toolRegistry, type AnyTool, type ToolContext } from "./tool.js";
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
  tools: AnyTool[];
  /** 無限ループ防止。ハーネスに必須の安全装置。 */
  maxTurns?: number;
  maxOutputTokens?: number;
  /** 1 ツール結果あたりの上限文字数。コンテキスト枯渇の最大要因を抑える。 */
  maxToolResultChars?: number;
  dryRun?: boolean;
  /** モデル呼び出し前にコンテキストを整える戦略。既定は何もしない。 */
  contextStrategy?: ContextStrategy;
  /** ツール実行の前後に差し込む処理。入力の書き換えと出力の加工に使う。 */
  hooks?: HarnessHooks;
  /** ツール実行の直前に挟む権限ゲート。既定は全許可。 */
  permission?: PermissionGate;
  /** ask を解決する係。既定は deny (無人実行を止めないため)。 */
  askResolver?: AskResolver;
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
  const permission = config.permission ?? allowAll;
  const askResolver = config.askResolver ?? denyOnAsk;
  const callCounts = new Map<string, number>();
  const contextStrategy = config.contextStrategy ?? noCompaction;
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

    // 圧縮結果は履歴に焼き込む。毎回元に戻すと同じ処理を繰り返すうえ、
    // プロンプトキャッシュの前方一致も毎ターン壊れる。
    const tokensBefore = estimateMessageTokens(messages);
    const edited = contextStrategy(messages);
    if (edited.edit) {
      messages.splice(0, messages.length, ...edited.messages);
      tracer.emit({
        type: "context_edit",
        turn,
        savedTokens: edited.edit.savedTokens,
        elidedResults: edited.edit.elidedResults,
        tokensBefore,
      });
    }
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

    // 呼び出し回数は並列実行の前に確定させる (同一ターン内の重複呼び出しを数えるため)。
    const numbered = toolUses.map((use) => {
      const priorCalls = callCounts.get(use.name) ?? 0;
      callCounts.set(use.name, priorCalls + 1);
      return { use, priorCalls };
    });

    // 並列に実行して、tool_use と同じ順序で結果を並べる。
    const results = await Promise.all(
      numbered.map(({ use, priorCalls }) =>
        executeToolUse({
          use,
          priorCalls,
          registry,
          ctx,
          tracer,
          turn,
          maxChars: maxToolResultChars,
          permission,
          askResolver,
          hooks: config.hooks,
        })
      )
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

interface ExecuteArgs {
  use: ToolUseBlock;
  priorCalls: number;
  registry: Map<string, AnyTool>;
  ctx: ToolContext;
  tracer: Tracer;
  turn: number;
  maxChars: number;
  permission: PermissionGate;
  askResolver: AskResolver;
  hooks?: HarnessHooks;
}

async function executeToolUse(args: ExecuteArgs): Promise<ToolResultBlock> {
  const { use, registry, ctx, tracer, turn, maxChars } = args;
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

  // 権限判定は「検証済みの入力」に対して行う。モデルの説明文ではなく実引数で決める。
  const decision = await args.permission({
    tool,
    input: parsed,
    turn,
    priorCalls: args.priorCalls,
    dryRun: ctx.dryRun,
  });
  let resolved: "allow" | "deny" = decision.behavior === "allow" ? "allow" : "deny";
  if (decision.behavior === "ask") {
    const approved = await args.askResolver(
      { tool, input: parsed, turn, priorCalls: args.priorCalls, dryRun: ctx.dryRun },
      decision.reason
    );
    resolved = approved ? "allow" : "deny";
  }
  tracer.emit({
    type: "permission",
    turn,
    toolUseId: use.id,
    name: use.name,
    behavior: decision.behavior,
    resolved,
    reason: decision.behavior === "allow" ? undefined : decision.reason,
  });
  if (resolved === "deny") {
    const reason = decision.behavior === "allow" ? "denied" : decision.reason;
    // 拒否もモデルに返す。理由が分かれば別の手段に切り替えられる。
    return finish(
      `Permission denied for "${use.name}": ${reason}. Do not retry this call; continue without it or report the limitation.`,
      true
    );
  }

  // beforeToolUse で入力を書き換えられる。書き換え後も必ず再検証して不変条件を保つ。
  if (args.hooks?.beforeToolUse) {
    const rewritten = await args.hooks.beforeToolUse({ tool, input: parsed, turn });
    if (rewritten) {
      try {
        parsed = tool.inputSchema.validate(rewritten.input, "");
      } catch (err) {
        return finish(formatValidationError(tool, err), true);
      }
    }
  }

  try {
    const raw = await tool.execute(parsed as never, ctx);
    let output = typeof raw === "string" ? { content: raw } : raw;
    if (args.hooks?.afterToolUse) {
      const patched = await args.hooks.afterToolUse({ tool, input: parsed, output, turn });
      if (patched) output = { ...output, ...patched };
    }
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
