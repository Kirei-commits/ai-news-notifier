import type { Provider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";

export type ProviderName = "anthropic" | "gemini";

export function createProvider(name: ProviderName, model?: string): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider({ model });
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set (required for --provider gemini)");
      return new GeminiProvider({ apiKey, model });
    }
    default:
      throw new Error(`Unknown provider: ${name satisfies never}`);
  }
}

export { AnthropicProvider, GeminiProvider };
