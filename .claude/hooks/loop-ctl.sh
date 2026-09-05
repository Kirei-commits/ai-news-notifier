#!/usr/bin/env bash
# ループの起動・停止・状態確認を行うコントローラ。
#
#   loop-ctl.sh start "<指示文>" [最大回数]   ループを起動する(既定 5 回)
#   loop-ctl.sh stop                          ループを停止する
#   loop-ctl.sh status                        現在の状態を表示する
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOP_DIR="$SCRIPT_DIR/../loop"
TASK_FILE="$LOOP_DIR/task.md"
COUNT_FILE="$LOOP_DIR/count"
MAX_FILE="$LOOP_DIR/max"

usage() {
  sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

case "${1:-}" in
  start)
    task="${2:-}"
    max="${3:-5}"
    [ -n "$task" ] || { echo "エラー: 指示文が空です。" >&2; usage 1; }
    [[ "$max" =~ ^[0-9]+$ ]] && [ "$max" -ge 1 ] || { echo "エラー: 最大回数は 1 以上の整数で指定してください。" >&2; exit 1; }
    mkdir -p "$LOOP_DIR"
    printf '%s\n' "$task" > "$TASK_FILE"
    printf '%s\n' "$max"  > "$MAX_FILE"
    printf '0\n'          > "$COUNT_FILE"
    echo "ループを起動しました (最大 ${max} 回)。"
    [ "$max" -gt 8 ] && echo "注意: 9 回以上まわすには環境変数 CLAUDE_CODE_STOP_HOOK_BLOCK_CAP の引き上げが必要です。"
    ;;
  stop)
    rm -f "$TASK_FILE" "$COUNT_FILE" "$MAX_FILE"
    echo "ループを停止しました。"
    ;;
  status)
    if [ -f "$TASK_FILE" ]; then
      echo "状態: 有効 ($(cat "$COUNT_FILE" 2>/dev/null || echo 0)/$(cat "$MAX_FILE" 2>/dev/null || echo '?') 回)"
      echo "--- 指示文 ---"
      cat "$TASK_FILE"
    else
      echo "状態: 無効"
    fi
    ;;
  ""|-h|--help|help) usage 0 ;;
  *) echo "エラー: 不明なコマンド '${1}'" >&2; usage 1 ;;
esac
