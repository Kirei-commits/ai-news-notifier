import { HttpError, parseRetryAfter, withRetry, type RetryOptions } from "../retry.js";
import type {
  ContentBlock,
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
  StopReason,
} from "../types.js";

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  retry?: RetryOptions;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Gemini (generateContent) 用アダプタ。
 *
 * Anthropic 版と並べて読むと、プロバイダ差がどこに出るかが分かる:
 *  - role 名が違う   ("assistant" ではなく "model")
 *  - ツール呼び出しに ID が無い       → ハーネス側で採番して対応表を作る
 *  - JSON Schema の方言が違う         → additionalProperties 等を落とし type を大文字化
 *  - 停止理由の語彙が違う             → 内部の StopReason に正規化
 * この 4 点はどのプロバイダでも形を変えて必ず出てくる。
 */
export class GeminiProvider implements Provider {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly retry: RetryOptions;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gemini-3.6-flash";
    this.baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    // Anthropic SDK は再試行を内蔵しているが、生 fetch には無いので自前で被せる。
    this.retry = options.retry ?? {};
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: toGeminiContents(request.messages),
      tools:
        request.tools.length > 0
          ? [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: toGeminiSchema(tool.inputSchema),
                })),
              },
            ]
          : undefined,
      generationConfig: { maxOutputTokens: request.maxOutputTokens },
    };

    const data = await withRetry<GeminiResponse>(async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        throw new HttpError(
          res.status,
          `Gemini generateContent failed: ${res.status} ${await res.text()}`,
          parseRetryAfter(res.headers.get("retry-after"))
        );
      }
      return (await res.json()) as GeminiResponse;
    }, { ...this.retry, signal });
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const content: ContentBlock[] = [];
    let callIndex = 0;
    for (const part of parts) {
      if (part.text) content.push({ type: "text", text: part.text });
      if (part.functionCall) {
        content.push({
          type: "tool_use",
          // Gemini は呼び出し ID を返さないのでハーネス側で採番する。
          id: `gemini_call_${callIndex++}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        });
      }
    }

    const hasToolUse = content.some((b) => b.type === "tool_use");
    return {
      content,
      stopReason: toStopReason(candidate?.finishReason, hasToolUse),
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      raw: data,
    };
  }
}

export function toGeminiContents(messages: Message[]): { role: string; parts: GeminiPart[] }[] {
  // functionResponse には呼び出し ID ではなく関数名が必要なので、対応表を先に作る。
  const nameByToolUseId = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") nameByToolUseId.set(block.id, block.name);
    }
  }

  const contents: { role: string; parts: GeminiPart[] }[] = [];
  for (const message of messages) {
    const parts: GeminiPart[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.text) parts.push({ text: block.text });
          break;
        case "tool_use":
          parts.push({ functionCall: { name: block.name, args: block.input as Record<string, unknown> } });
          break;
        case "tool_result":
          parts.push({
            functionResponse: {
              name: nameByToolUseId.get(block.toolUseId) ?? "unknown",
              response: block.isError
                ? { error: block.content }
                : { result: block.content },
            },
          });
          break;
        case "opaque":
          break;
      }
    }
    if (parts.length > 0) {
      contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
    }
  }
  return contents;
}

/**
 * JSON Schema を Gemini が受け付ける方言へ落とす。
 * 未知のキーを送ると 400 になるため、通すキーをホワイトリストで決める。
 */
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (typeof schema.type === "string") out.type = schema.type.toUpperCase();
  if (typeof schema.description === "string") out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (Array.isArray(schema.required) && schema.required.length > 0) out.required = schema.required;

  if (schema.items && typeof schema.items === "object") {
    out.items = toGeminiSchema(schema.items as Record<string, unknown>);
  }
  if (schema.properties && typeof schema.properties === "object") {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
      properties[key] = toGeminiSchema(value as Record<string, unknown>);
    }
    out.properties = properties;
  }
  // additionalProperties / minimum / maximum などは Gemini が受け付けないので落とす。
  return out;
}

function toStopReason(finishReason: string | undefined, hasToolUse: boolean): StopReason {
  switch (finishReason) {
    case "STOP":
      return hasToolUse ? "tool_use" : "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "refusal";
    default:
      return hasToolUse ? "tool_use" : "other";
  }
}
