import type { PermissionGate } from "../src/harness/permission.js";
import type { ScriptedTurn } from "../src/harness/providers/mock.js";
import type { Tool } from "../src/harness/tool.js";
import type { Assertion } from "./assertions.js";

export interface BuiltCase {
  tools: Tool<never>[];
  system: string;
  expect: Assertion[];
}

export interface EvalCase {
  name: string;
  description?: string;
  /** エージェントへの指示。 */
  input: string;
  /** mock プロバイダで回すための台本。無い場合、mock 実行ではスキップされる。 */
  script?: ScriptedTurn[];
  dryRun?: boolean;
  permission?: PermissionGate;
  maxTurns?: number;
  /**
   * 1 実行ぶんの環境を組み立てる。
   * 毎回呼ぶことで、ケース間で状態が漏れない（評価の再現性はここで決まる）。
   */
  build(): BuiltCase;
}
