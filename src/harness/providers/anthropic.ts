import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
  StopReason,
} from "../types.js";

export interface AnthropicProviderOptions {
  model?: string;
  /** low | medium | high | xhigh | max。低いほど安く速い。 */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: Anthropic;
}

/**
 * Anthropic Messages API 用アダプタ。
 *
 * ここでやることは 2 方向の変換だけに保つ。判断はループ側に置く。
 * thinking ブロックは中身を解釈せず opaque として持ち回り、次のリクエストにそのまま戻す
 * (署名付きのため改変も欠落も許されない)。
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: NonNullable<AnthropicProviderOptions["effort"]>;

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? "claude-opus-5";
    this.effort = options.effort ?? "high";
    // 引数なしの構築で ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ant auth プロファイルを解決する
    this.client = options.client ?? new Anthropic();
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    // ストリーミング + finalMessage() は長い出力での HTTP タイムアウトを避けるための定石。
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: toAnthropicMessages(request.messages),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
        })),
        thinking: { type: "adaptive" },
        output_config: { effort: this.effort },
      },
      { signal }
    );
    const message = await stream.finalMessage();

    return {
      content: message.content.map(fromAnthropicBlock),
      stopReason: toStopReason(message.stop_reason),
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
      raw: message,
    };
  }
}

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(toAnthropicBlock),
  }));
}

function toAnthropicBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
    case "opaque":
      // 自分が作った opaque だけ戻す。他プロバイダのものを混ぜると 400 になる。
      if (block.provider !== "anthropic") {
        return { type: "text", text: "" };
      }
      return block.data as Anthropic.ContentBlockParam;
  }
}

function fromAnthropicBlock(block: Anthropic.ContentBlock): ContentBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  // thinking / redacted_thinking / server tool 系はハーネスが解釈しない。そのまま持ち回る。
  return { type: "opaque", provider: "anthropic", data: block };
}

function toStopReason(stopReason: Anthropic.Message["stop_reason"]): StopReason {
  switch (stopReason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}
