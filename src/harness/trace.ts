import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ContentBlock, Message, StopReason, Usage } from "./types.js";

/**
 * 構造化トレース。
 *
 * エージェントのデバッグは「モデルに何を送り、何が返ったか」の全文がないと不可能。
 * 要約したログは役に立たないので、送信内容はそのまま残す。
 */
export type HarnessEvent =
  | {
      type: "run_start";
      runId: string;
      at: string;
      provider: string;
      model: string;
      system: string;
      tools: string[];
      input: Message[];
    }
  | { type: "turn_start"; turn: number }
  | { type: "model_request"; turn: number; messages: Message[] }
  | {
      type: "model_response";
      turn: number;
      stopReason: StopReason;
      usage: Usage;
      content: ContentBlock[];
    }
  | { type: "tool_start"; turn: number; toolUseId: string; name: string; input: unknown }
  | {
      type: "tool_end";
      turn: number;
      toolUseId: string;
      name: string;
      ok: boolean;
      durationMs: number;
      content: string;
      meta?: Record<string, unknown>;
    }
  | {
      type: "run_end";
      stopReason: string;
      turns: number;
      usage: Usage;
      text: string;
      error?: string;
    };

export interface Tracer {
  emit(event: HarnessEvent): void;
  readonly events: HarnessEvent[];
}

export function memoryTracer(): Tracer {
  const events: HarnessEvent[] = [];
  return { events, emit: (e) => void events.push(e) };
}

/**
 * JSONL で 1 イベントずつ即時追記する。
 * バッファすると「落ちた時のトレースが残らない」という一番欲しい場面で失われる。
 */
export function fileTracer(runId: string, dir = ".harness/traces"): Tracer {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.jsonl`);
  const events: HarnessEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
      appendFileSync(file, JSON.stringify(event) + "\n");
    },
  };
}

export function combineTracers(...tracers: Tracer[]): Tracer {
  const events: HarnessEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
      for (const t of tracers) t.emit(event);
    },
  };
}

/** 人間が読むための短い実況。CLI 用。 */
export function consoleTracer(write: (line: string) => void = console.error): Tracer {
  const events: HarnessEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
      switch (event.type) {
        case "run_start":
          write(`▶ run ${event.runId} (${event.provider}/${event.model})`);
          break;
        case "model_response": {
          const text = event.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { text: string }).text)
            .join(" ")
            .trim();
          if (text) write(`  💬 ${text.slice(0, 200)}`);
          break;
        }
        case "tool_start":
          write(`  🔧 ${event.name}(${JSON.stringify(event.input)})`);
          break;
        case "tool_end":
          write(
            `  ${event.ok ? "✓" : "✗"} ${event.name} ${event.durationMs}ms — ${event.content.slice(0, 120).replace(/\n/g, " ")}`
          );
          break;
        case "run_end":
          write(
            `■ ${event.stopReason} / ${event.turns} turns / in ${event.usage.inputTokens} out ${event.usage.outputTokens} tokens`
          );
          break;
      }
    },
  };
}
