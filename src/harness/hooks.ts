import type { AnyTool, ToolOutput } from "./tool.js";

/**
 * フック。ツール実行の前後に決定的な処理を差し込む口。
 *
 * 権限ゲートとの役割分担:
 *   - 権限ゲート = 実行するかしないかの判断 (allow / deny / ask)
 *   - フック     = 実行するものの中身への介入 (入力の書き換え、出力の加工、記録)
 * ここを混ぜると「なぜ実行されなかったのか」が追えなくなる。
 */
export interface BeforeToolUseEvent {
  tool: AnyTool;
  /** スキーマ検証・権限判定を通過した入力。 */
  input: unknown;
  turn: number;
}

export interface AfterToolUseEvent {
  tool: AnyTool;
  input: unknown;
  output: ToolOutput;
  turn: number;
}

export interface HarnessHooks {
  /** 戻り値で入力を差し替えられる。差し替え後も必ず再検証される。 */
  beforeToolUse?(
    event: BeforeToolUseEvent
  ): void | { input: unknown } | Promise<void | { input: unknown }>;
  /** 戻り値でモデルに見せる結果を差し替えられる。 */
  afterToolUse?(
    event: AfterToolUseEvent
  ): void | Partial<ToolOutput> | Promise<void | Partial<ToolOutput>>;
}

/**
 * ツール出力から秘密情報を落とすフック。
 *
 * ツール結果はそのままモデルへ、そしてトレースへ流れる。
 * 環境変数の値が一度でも混ざると、ログにも会話履歴にも残り続ける。
 */
export function redactSecrets(
  values: (string | undefined)[] = [
    process.env.DISCORD_WEBHOOK_URL,
    process.env.GEMINI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ]
): HarnessHooks {
  // 短すぎる値を置換対象にすると出力が壊れるので下限を設ける。
  const secrets = values.filter((v): v is string => typeof v === "string" && v.length >= 8);

  return {
    afterToolUse({ output }) {
      if (secrets.length === 0) return;
      let content = output.content;
      for (const secret of secrets) content = content.split(secret).join("[REDACTED]");
      return content === output.content ? undefined : { content };
    },
  };
}

/** 複数のフックを順に適用する。 */
export function combineHooks(...hooks: HarnessHooks[]): HarnessHooks {
  return {
    async beforeToolUse(event) {
      let input = event.input;
      for (const hook of hooks) {
        const result = await hook.beforeToolUse?.({ ...event, input });
        if (result) input = result.input;
      }
      return input === event.input ? undefined : { input };
    },
    async afterToolUse(event) {
      let output = event.output;
      for (const hook of hooks) {
        const result = await hook.afterToolUse?.({ ...event, output });
        if (result) output = { ...output, ...result };
      }
      return output === event.output ? undefined : output;
    },
  };
}
