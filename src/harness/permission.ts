import type { Tool, ToolKind } from "./tool.js";

/**
 * 権限ゲート。
 *
 * 設計上の要点:
 *  - ゲートは「検証済みの入力」を見る。モデルの申告文ではなく実際に渡る引数で判断する。
 *  - deny はループを止めない。理由をツール結果としてモデルに返し、別の手段を取らせる。
 *  - ask を無人実行で放置すると固まるので、非対話時は必ず deny に落ちる実装にする。
 */
export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; reason: string }
  | { behavior: "ask"; reason: string };

export interface PermissionRequest {
  tool: Tool<never>;
  /** スキーマ検証を通った後の入力。 */
  input: unknown;
  turn: number;
  /** この run で当該ツールが既に呼ばれた回数 (今回を含まない)。 */
  priorCalls: number;
  dryRun: boolean;
}

export type PermissionGate = (
  request: PermissionRequest
) => PermissionDecision | Promise<PermissionDecision>;

export const ALLOW: PermissionDecision = { behavior: "allow" };

export const allowAll: PermissionGate = () => ALLOW;

/** 読み取り専用。調査・評価用の run で使う。 */
export const readOnly: PermissionGate = ({ tool }) =>
  tool.kind === "read"
    ? ALLOW
    : { behavior: "deny", reason: `this run is read-only; "${tool.name}" (${tool.kind}) is not permitted` };

export interface PolicyOptions {
  /** 常に許可するツール名。 */
  allow?: string[];
  /** 常に拒否するツール名。allow より優先する。 */
  deny?: string[];
  /** この種別のツールは確認を求める。 */
  ask?: ToolKind[];
  /** ツールごとの呼び出し回数上限。 */
  maxCalls?: Record<string, number>;
}

export function policyGate(options: PolicyOptions = {}): PermissionGate {
  const { allow = [], deny = [], ask = [], maxCalls = {} } = options;

  return (request) => {
    const { tool, priorCalls } = request;

    if (deny.includes(tool.name)) {
      return { behavior: "deny", reason: `"${tool.name}" is disabled for this run` };
    }

    const limit = maxCalls[tool.name];
    if (limit !== undefined && priorCalls >= limit) {
      return {
        behavior: "deny",
        reason: `"${tool.name}" may be called at most ${limit} time(s) per run; it was already called ${priorCalls} time(s)`,
      };
    }

    if (allow.includes(tool.name)) return ALLOW;
    if (ask.includes(tool.kind)) {
      return { behavior: "ask", reason: `"${tool.name}" is ${tool.kind}` };
    }
    return ALLOW;
  };
}

/**
 * 既定の運用ポリシー。
 * dry-run 中は何を呼んでも安全なので通し、実行モードでは破壊的ツールに確認を挟む。
 */
export function defaultGate(options: { maxCalls?: Record<string, number> } = {}): PermissionGate {
  const policy = policyGate({
    ask: ["destructive"],
    maxCalls: { post_discord: 1, ...options.maxCalls },
  });
  return (request) => (request.dryRun ? policyGate({ maxCalls: options.maxCalls })(request) : policy(request));
}

/**
 * ask を解決する側。
 * 対話端末がなければ deny に落とす — 無人実行でブロックしないことが安全側。
 */
export type AskResolver = (request: PermissionRequest, reason: string) => Promise<boolean>;

export const denyOnAsk: AskResolver = async () => false;

export function stdinAskResolver(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr
): AskResolver {
  return async (request, reason) => {
    if (!input.isTTY) return false;
    output.write(
      `\n⚠ ${reason}\n  ${request.tool.name}(${JSON.stringify(request.input).slice(0, 500)})\n  許可しますか? [y/N] `
    );
    const answer = await new Promise<string>((resolve) => {
      const onData = (chunk: Buffer) => {
        input.off("data", onData);
        input.pause();
        resolve(chunk.toString().trim().toLowerCase());
      };
      input.resume();
      input.once("data", onData);
    });
    return answer === "y" || answer === "yes";
  };
}
