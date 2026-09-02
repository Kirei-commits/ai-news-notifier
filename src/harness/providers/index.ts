import type { Provider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";

export type ProviderName = "anthropic" | "gemini";

/** 設定ミス。バグではないのでスタックトレースを出さずに伝える。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function createProvider(name: ProviderName, model?: string): Provider {
  switch (name) {
    case "anthropic":
      try {
        // 認証情報の解決は SDK に任せる。ANTHROPIC_API_KEY が未設定でも
        // ANTHROPIC_AUTH_TOKEN や `ant auth login` のプロファイルで動くため、
        // 環境変数を自前で事前チェックすると正当な構成を弾いてしまう。
        return new AnthropicProvider({ model });
      } catch (err) {
        throw new ConfigError(
          `Anthropic クライアントを初期化できません: ${err instanceof Error ? err.message : String(err)}\n` +
            "ANTHROPIC_API_KEY を設定するか `ant auth login` を実行してください。"
        );
      }
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new ConfigError("GEMINI_API_KEY is not set (required for --provider gemini)");
      }
      return new GeminiProvider({ apiKey, model });
    }
    default:
      throw new ConfigError(`Unknown provider: ${name satisfies never}`);
  }
}

export { AnthropicProvider, GeminiProvider };
