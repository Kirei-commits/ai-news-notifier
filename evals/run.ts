import "dotenv/config";
import { parseArgs } from "node:util";
import { estimateCostUsd } from "../src/harness/cost.js";
import { run } from "../src/harness/loop.js";
import { mockProvider } from "../src/harness/providers/mock.js";
import { createProvider, type ProviderName } from "../src/harness/providers/index.js";
import { memoryTracer } from "../src/harness/trace.js";
import type { Provider } from "../src/harness/types.js";
import type { AssertionResult, EvalContext } from "./assertions.js";
import { ALL_CASES } from "./cases/index.js";
import type { EvalCase } from "./types.js";

interface CaseOutcome {
  name: string;
  status: "pass" | "fail" | "skip";
  reason?: string;
  assertions: AssertionResult[];
  turns: number;
  costUsd: number | null;
}

async function runCase(testCase: EvalCase, providerName: string, model?: string): Promise<CaseOutcome> {
  const built = testCase.build();
  const useMock = providerName === "mock";

  if (useMock && !testCase.script) {
    return {
      name: testCase.name,
      status: "skip",
      reason: "台本が無い (実モデルでのみ評価可能)",
      assertions: [],
      turns: 0,
      costUsd: null,
    };
  }

  const provider: Provider = useMock
    ? mockProvider(testCase.script!)
    : createProvider(providerName as ProviderName, model);

  const tracer = memoryTracer();
  const result = await run(testCase.input, {
    provider,
    system: built.system,
    tools: built.tools,
    dryRun: testCase.dryRun ?? true,
    permission: testCase.permission,
    maxTurns: testCase.maxTurns ?? 12,
    tracer,
  });

  // トレースからツール呼び出しの履歴を組み立てる。
  // 評価対象は「最終出力」だけではなく「途中で何をしたか」であることが多い。
  const toolCalls: EvalContext["toolCalls"] = [];
  const toolResults: EvalContext["toolResults"] = [];
  for (const event of tracer.events) {
    if (event.type === "tool_start") toolCalls.push({ name: event.name, input: event.input });
    if (event.type === "tool_end") {
      toolResults.push({ name: event.name, content: event.content, ok: event.ok });
    }
  }

  const ctx: EvalContext = {
    result,
    events: tracer.events,
    toolCalls,
    toolResults,
    model: provider.model,
  };
  const assertions = built.expect.map((assertion) => assertion(ctx));

  return {
    name: testCase.name,
    status: assertions.every((a) => a.ok) ? "pass" : "fail",
    assertions,
    turns: result.turns,
    costUsd: estimateCostUsd(result.usage, provider.model),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: "string", default: "mock" },
      model: { type: "string" },
      filter: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });

  const cases = values.filter
    ? ALL_CASES.filter((c) => c.name.includes(values.filter!))
    : ALL_CASES;

  const outcomes: CaseOutcome[] = [];
  for (const testCase of cases) {
    try {
      outcomes.push(await runCase(testCase, values.provider!, values.model));
    } catch (err) {
      outcomes.push({
        name: testCase.name,
        status: "fail",
        reason: err instanceof Error ? err.message : String(err),
        assertions: [],
        turns: 0,
        costUsd: null,
      });
    }
  }

  if (values.json) {
    console.log(JSON.stringify(outcomes, null, 2));
  } else {
    report(outcomes, values.provider!);
  }

  if (outcomes.some((o) => o.status === "fail")) process.exitCode = 1;
}

function report(outcomes: CaseOutcome[], provider: string): void {
  const icon = { pass: "✓", fail: "✗", skip: "－" } as const;
  console.log(`\nprovider: ${provider}\n`);

  for (const outcome of outcomes) {
    const cost = outcome.costUsd === null ? "" : ` $${outcome.costUsd.toFixed(4)}`;
    const meta = outcome.status === "skip" ? ` (${outcome.reason})` : ` [${outcome.turns} turns${cost}]`;
    console.log(`${icon[outcome.status]} ${outcome.name}${meta}`);
    if (outcome.reason && outcome.status === "fail") console.log(`    ! ${outcome.reason}`);
    for (const assertion of outcome.assertions) {
      if (assertion.ok) continue;
      console.log(`    ✗ ${assertion.label}${assertion.detail ? ` — ${assertion.detail}` : ""}`);
    }
  }

  const pass = outcomes.filter((o) => o.status === "pass").length;
  const fail = outcomes.filter((o) => o.status === "fail").length;
  const skip = outcomes.filter((o) => o.status === "skip").length;
  const totalCost = outcomes.reduce((sum, o) => sum + (o.costUsd ?? 0), 0);
  console.log(
    `\n${pass} passed, ${fail} failed, ${skip} skipped` +
      (totalCost > 0 ? ` / 合計 ~$${totalCost.toFixed(4)}` : "")
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
