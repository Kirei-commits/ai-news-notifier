/**
 * リトライ。
 *
 * ハーネスが実運用で最初に落ちるのは大体ここ。押さえる点は 3 つ:
 *  1. 再試行して意味がある失敗だけ再試行する (400 を10回投げても400のまま)
 *  2. 指数バックオフ + ジッタ。固定間隔だと複数プロセスが同時に叩き直す
 *  3. サーバが retry-after を返しているなら、それを最優先で尊重する
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  signal?: AbortSignal;
  /** テスト用の待機関数。 */
  sleep?: (ms: number) => Promise<void>;
  /** テスト用の乱数 (0..1)。 */
  random?: () => number;
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  // ネットワーク断はほぼ常に再試行の価値がある。abort は利用者の意思なので除く。
  if (error instanceof Error) {
    if (error.name === "AbortError") return false;
    return error.name === "TypeError" || /fetch failed|ECONN|ETIMEDOUT|socket hang up/i.test(error.message);
  }
  return false;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function backoffDelay(attempt: number, options: RetryOptions = {}): number {
  const base = options.baseMs ?? 500;
  const max = options.maxMs ?? 20_000;
  const random = options.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** (attempt - 1));
  // full jitter: 0..ceiling の一様乱数。同時再試行の山を崩す。
  return Math.round(ceiling * random());
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const retries = options.retries ?? 3;
  const isRetryable = options.isRetryable ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt > retries || !isRetryable(error) || options.signal?.aborted) throw error;

      const retryAfter = error instanceof HttpError ? error.retryAfterMs : undefined;
      const delayMs = retryAfter ?? backoffDelay(attempt, options);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/** Retry-After ヘッダ (秒 または HTTP-date) をミリ秒に変換する。 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
