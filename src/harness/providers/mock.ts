import type {
  ContentBlock,
  ModelRequest,
  ModelResponse,
  Provider,
  StopReason,
} from "../types.js";

/**
 * 台本どおりに応答するプロバイダ。
 *
 * これがあるとハーネスのテストが API キー無し・課金無し・完全決定的に書ける。
 * 「ループの挙動」と「モデルの賢さ」を分離して検証するための道具。
 */
export type ScriptedTurn =
  | ModelResponse
  | ((request: ModelRequest, turn: number) => ModelResponse | Promise<ModelResponse>);

export interface MockProviderOptions {
  name?: string;
  model?: string;
  /** 台本を使い切った後の挙動。既定では末尾を繰り返さずエラーにする。 */
  onExhausted?: "throw" | "end_turn";
}

export class MockProvider implements Provider {
  readonly name: string;
  readonly model: string;
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(
    private readonly script: ScriptedTurn[],
    private readonly options: MockProviderOptions = {}
  ) {
    this.name = options.name ?? "mock";
    this.model = options.model ?? "mock-1";
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // structuredClone しないと、後続ターンで messages を変異させた影響が過去の記録に及ぶ。
    this.requests.push(structuredClone(request));
    const turn = this.index++;
    const entry = this.script[turn];

    if (entry === undefined) {
      if (this.options.onExhausted === "end_turn") return say("(script exhausted)");
      throw new Error(`MockProvider: script exhausted at turn ${turn + 1}`);
    }
    return typeof entry === "function" ? entry(request, turn + 1) : entry;
  }
}

export function mockProvider(script: ScriptedTurn[], options?: MockProviderOptions): MockProvider {
  return new MockProvider(script, options);
}

const NO_USAGE = { inputTokens: 0, outputTokens: 0 };

export function say(text: string, usage = NO_USAGE): ModelResponse {
  return { content: [{ type: "text", text }], stopReason: "end_turn", usage };
}

export function callTools(
  calls: { name: string; input: unknown; id?: string }[],
  text?: string,
  usage = NO_USAGE
): ModelResponse {
  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  calls.forEach((call, i) => {
    content.push({
      type: "tool_use",
      id: call.id ?? `call_${i}`,
      name: call.name,
      input: call.input,
    });
  });
  return { content, stopReason: "tool_use", usage };
}

export function stopWith(stopReason: StopReason, text = "", usage = NO_USAGE): ModelResponse {
  return { content: text ? [{ type: "text", text }] : [], stopReason, usage };
}
