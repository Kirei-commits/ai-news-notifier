import "dotenv/config";
import { parseArgs } from "node:util";
import { elideOldToolResults } from "./context.js";
import { formatUsage } from "./cost.js";
import { newRunId, run } from "./loop.js";
import { defaultGate, stdinAskResolver } from "./permission.js";
import { createProvider, type ProviderName } from "./providers/index.js";
import { NEWS_SYSTEM_PROMPT, newsTools } from "./tools/news.js";
import { combineTracers, consoleTracer, fileTracer } from "./trace.js";

const USAGE = `使い方:
  npm run agent -- "<指示>" [options]

options:
  --provider <anthropic|gemini>  既定: anthropic
  --model <id>                   プロバイダ既定のモデルを上書き
  --max-turns <n>                既定: 12
  --execute                      副作用を実際に起こす (既定は dry-run)
  --quiet                        実況を出さない
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string", default: "anthropic" },
      model: { type: "string" },
      "max-turns": { type: "string", default: "12" },
      execute: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const input = positionals.join(" ").trim();
  if (values.help || !input) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const runId = newRunId();
  const tracer = values.quiet
    ? fileTracer(runId)
    : combineTracers(fileTracer(runId), consoleTracer());

  // Ctrl-C は「途中経過ごと捨てる」のではなく、ループの停止条件として扱う。
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  const result = await run(input, {
    runId,
    provider: createProvider(values.provider as ProviderName, values.model),
    system: NEWS_SYSTEM_PROMPT,
    tools: newsTools,
    maxTurns: Number(values["max-turns"]),
    dryRun: !values.execute,
    contextStrategy: elideOldToolResults({ maxTokens: 120_000 }),
    permission: defaultGate(),
    askResolver: stdinAskResolver(),
    signal: controller.signal,
    tracer,
  });

  console.log(`\n${result.text}\n`);
  const provider = values.provider as string;
  console.error(
    `--- ${result.stopReason} / ${result.turns} turns / ${formatUsage(result.usage, values.model ?? (provider === "anthropic" ? "claude-opus-5" : "gemini"))}`
  );
  console.error(`--- trace: .harness/traces/${runId}.jsonl`);
  if (!values.execute) console.error("--- dry-run (実投稿するには --execute)");
  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
