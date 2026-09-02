import { readFileSync } from "node:fs";
import type { HarnessEvent } from "../trace.js";
import type { ModelRequest, ModelResponse, Provider } from "../types.js";

export interface ReplayOptions {
  /**
   * true のとき、記録時とリクエスト形状が食い違ったら失敗させる。
   * ハーネスを変更した結果「モデルに渡るものが変わった」ことを検出するための機能で、
   * リプレイの価値の大半はここにある。
   */
  strict?: boolean;
  model?: string;
}

interface RecordedTurn {
  request?: ModelRequest;
  response: ModelResponse;
}

/**
 * 記録済みトレースからモデル応答を再生するプロバイダ。
 *
 * これがあると「モデルを呼ばずにハーネスの変更を検証する」ことができる。
 * 課金もレート制限も揺らぎも無いので、CI で回せる。
 */
export class ReplayProvider implements Provider {
  readonly name = "replay";
  readonly model: string;
  private index = 0;

  constructor(
    private readonly turns: RecordedTurn[],
    private readonly options: ReplayOptions = {}
  ) {
    this.model = options.model ?? "replay";
  }

  static fromEvents(events: HarnessEvent[], options: ReplayOptions = {}): ReplayProvider {
    let system = "";
    const requestByTurn = new Map<number, ModelRequest>();
    const turns: RecordedTurn[] = [];

    for (const event of events) {
      switch (event.type) {
        case "run_start":
          system = event.system;
          break;
        case "model_request":
          requestByTurn.set(event.turn, {
            system,
            messages: event.messages,
            tools: [],
            maxOutputTokens: 0,
          });
          break;
        case "model_response":
          turns.push({
            request: requestByTurn.get(event.turn),
            response: {
              content: event.content,
              stopReason: event.stopReason,
              usage: event.usage,
            },
          });
          break;
      }
    }

    if (turns.length === 0) {
      throw new Error("ReplayProvider: trace contains no model_response events");
    }
    return new ReplayProvider(turns, options);
  }

  static fromFile(path: string, options: ReplayOptions = {}): ReplayProvider {
    const events = readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as HarnessEvent);
    return ReplayProvider.fromEvents(events, options);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const turn = this.turns[this.index++];
    if (!turn) {
      throw new Error(
        `ReplayProvider: no recorded response for turn ${this.index} (trace had ${this.turns.length})`
      );
    }
    if (this.options.strict && turn.request) {
      const drift = describeDrift(turn.request, request);
      if (drift) {
        throw new Error(`ReplayProvider: request drifted at turn ${this.index}: ${drift}`);
      }
    }
    return turn.response;
  }
}

function describeDrift(recorded: ModelRequest, actual: ModelRequest): string | null {
  if (recorded.system !== actual.system) {
    return "system prompt changed";
  }
  if (recorded.messages.length !== actual.messages.length) {
    return `message count ${recorded.messages.length} → ${actual.messages.length}`;
  }
  for (const [i, message] of recorded.messages.entries()) {
    const other = actual.messages[i];
    if (message.role !== other.role) return `messages[${i}].role ${message.role} → ${other.role}`;
    if (message.content.length !== other.content.length) {
      return `messages[${i}] block count ${message.content.length} → ${other.content.length}`;
    }
  }
  return null;
}
