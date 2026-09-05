# ai-news-notifier

AIの最新情報をRSSから収集し、Discordに定期通知するNode.js/TypeScriptアプリ。

## 構成

- `src/sources.ts` — 収集するRSSフィード一覧
- `src/index.ts` — フィード取得 → 未通知アイテムの抽出 → Discord投稿のメイン処理
- `src/discord.ts` — Discord Webhookへの投稿(2000文字制限の分割、レート制限対応込み)
- `src/seenStore.ts` — 既読アイテムIDの永続化 (`data/seen.json`)
- `.github/workflows/notify.yml` — 定期実行 (GitHub Actions)
- `.github/workflows/ci.yml` — lint / test / build / audit / コンテナ (push・PR)
- `.github/workflows/codeql.yml` — CodeQL 静的解析
- `.github/workflows/security.yml` — Trivy スキャン

## 開発

```bash
npm install
npm run dev      # ファイル監視で実行

# push 前にこの3つが通ることを確認する (CI と同じ内容)
npm run lint
npm run typecheck
npm run test:coverage
```

`npm run format` で Prettier 整形。CI では `format:check` で検査するため、
整形漏れがあると落ちる。

Node.jsは nvm 経由でインストール済み (`~/.nvm`)。シェルを新規に開く場合は `nvm use --lts` が必要。

## 注意点

- `data/seen.json` は重複通知防止のための状態ファイル。GitHub Actions上で更新後に自動コミットされるため、ローカルでの不要なコミットに注意。
- 新しいRSSソースを追加する際は、実際にcurlでレスポンスを確認してからURLを追加すること(存在しないURLを推測で追加しない)。
- ESLint は型情報つき (`recommendedTypeChecked`)。`JSON.parse` の結果をそのまま使うと
  `no-unsafe-*` で落ちるため、`unknown` で受けて実行時に検証すること。
- ビルドは `tsconfig.build.json` を使い `*.test.ts` を除外する。`tsconfig.json` 側は
  テストも含めて型検査する用。
- カバレッジ閾値は `vitest.config.ts` で lines/functions 80%、branches 75%。
  `src/index.ts` は import 時に `main()` が走るため計測対象外。

## ループ実行 (Stop hook)

同じ指示を繰り返し実行させたいときに使う仕組み。`.claude/hooks/loop.sh` が Stop hook
として動き、ループが有効な間はターンの終了をブロックして指示文を再投入する。

```bash
.claude/hooks/loop-ctl.sh start "<指示文>" [最大回数]   # 起動 (既定 5 回)
.claude/hooks/loop-ctl.sh status                        # 状態確認
.claude/hooks/loop-ctl.sh stop                          # 途中で停止
```

- 起動していない間はフックが即座に終了するため、通常のセッションには影響しない。
- 回数は `.claude/loop/count` の自前カウンタで管理し、上限に達すると自動で解除される。
- Claude Code 側にも「Stop hook の連続ブロックは既定 8 回まで」という安全装置がある。
  9 回以上まわす場合は `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` を引き上げること。
- `.claude/loop/` は実行時の状態ファイルなのでコミットしない (`.gitignore` 済み)。
