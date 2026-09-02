import { run, type RunConfig } from "./loop.js";
import { str } from "./schema.js";
import { defineTool, type AnyTool } from "./tool.js";
import { memoryTracer } from "./trace.js";
import type { Provider } from "./types.js";

export interface SubagentOptions {
  name: string;
  /** 親エージェント向けの説明。「いつ委譲すべきか」を書く。 */
  description: string;
  /** サブエージェント自身のシステムプロンプト。 */
  system: string;
  tools: AnyTool[];
  provider: Provider;
  maxTurns?: number;
  permission?: RunConfig["permission"];
  /** task 引数の説明。曖昧だと親が丸投げしてくる。 */
  taskDescription?: string;
}

/**
 * サブエージェントをツールとして公開する。
 *
 * 狙いは「親のコンテキストを汚さないこと」の一点に尽きる。
 * 探索は 10 ターン回っても、親が受け取るのは最終的な結論のテキストだけ。
 * 調査系のタスクでは、これがあるかないかで親の寿命が桁で変わる。
 *
 * 代償は、親が途中経過を見られないこと。デバッグのために usage と turns は
 * meta としてトレースに残す。
 */
export function defineSubagentTool(options: SubagentOptions): AnyTool {
  const tool = defineTool({
    name: options.name,
    description: options.description,
    kind: "read",
    input: {
      task: str(
        options.taskDescription ??
          "The task to delegate, written as a self-contained instruction. The subagent cannot see this conversation."
      ),
    },
    async execute(input, ctx) {
      const tracer = memoryTracer();
      const result = await run(input.task, {
        provider: options.provider,
        system: options.system,
        tools: options.tools,
        maxTurns: options.maxTurns ?? 8,
        permission: options.permission,
        dryRun: ctx.dryRun,
        signal: ctx.signal,
        tracer,
      });

      if (result.stopReason === "error") {
        return {
          content: `Subagent "${options.name}" failed: ${result.error?.message ?? "unknown error"}`,
          isError: true,
          meta: { turns: result.turns, usage: result.usage },
        };
      }

      const notice =
        result.stopReason === "max_turns"
          ? "\n\n(注意: サブエージェントはターン上限に達したため、結論が不完全な可能性がある)"
          : "";

      return {
        // 親に渡すのは結論のみ。中間のツール結果は持ち帰らない。
        content: `${result.text}${notice}`,
        meta: { turns: result.turns, usage: result.usage, stopReason: result.stopReason },
      };
    },
  });
  return tool as unknown as AnyTool;
}
