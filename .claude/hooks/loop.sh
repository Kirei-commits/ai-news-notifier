#!/usr/bin/env bash
# Stop hook: ループが有効な間、同じ指示を再投入して Claude に作業を継続させる。
#
# 標準入力に Claude Code から JSON が渡る。ループが無効なら何も出力せず終了し、
# 有効なら {"decision":"block","reason":...} を返してターンの終了をブロックする。
#
# 回数の制御は .claude/loop/count の自前カウンタで行う。フック入力の
# stop_hook_active で早期 return すると継続が1回で打ち切られてしまうため使わない。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOP_DIR="$SCRIPT_DIR/../loop"
TASK_FILE="$LOOP_DIR/task.md"
COUNT_FILE="$LOOP_DIR/count"
MAX_FILE="$LOOP_DIR/max"

# ループ未起動なら何もしない(通常のセッションは必ずここで抜ける)
[ -f "$TASK_FILE" ] || exit 0

# jq が無い環境では JSON を安全に組み立てられないので停止側に倒す
command -v jq >/dev/null 2>&1 || exit 0

max=$(cat "$MAX_FILE" 2>/dev/null || echo 5)
count=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
[[ "$max"   =~ ^[0-9]+$ ]] || max=5
[[ "$count" =~ ^[0-9]+$ ]] || count=0

if [ "$count" -ge "$max" ]; then
  rm -f "$TASK_FILE" "$COUNT_FILE" "$MAX_FILE"
  jq -cn --arg m "$max" '{systemMessage:("ループ終了: " + $m + "回実行しました。")}'
  exit 0
fi

next=$((count + 1))
# カウンタを更新できない場合は暴走を避けてループを解除する
if ! printf '%s\n' "$next" > "$COUNT_FILE" 2>/dev/null; then
  rm -f "$TASK_FILE"
  jq -cn '{systemMessage:"ループ停止: カウンタを更新できませんでした。"}'
  exit 0
fi

task=$(cat "$TASK_FILE")
reason=$(printf 'ループ %s/%s 回目です。以下のタスクの続きを実行してください。\nすでに完了している場合は `.claude/hooks/loop-ctl.sh stop` を実行してループを止めてください。\n\n---\n%s\n' "$next" "$max" "$task")

jq -cn --arg r "$reason" '{decision:"block", reason:$r}'
