# ai-news-notifier

AIの最新情報をRSSから収集し、Discordに定期通知するNode.js/TypeScriptアプリ。

## 構成

- `src/sources.ts` — 収集するRSSフィード一覧
- `src/index.ts` — フィード取得 → 未通知アイテムの抽出 → Discord投稿のメイン処理
- `src/discord.ts` — Discord Webhookへの投稿(2000文字制限の分割、レート制限対応込み)
- `src/seenStore.ts` — 既読アイテムIDの永続化 (`data/seen.json`)
- `.github/workflows/notify.yml` — 6時間おきの自動実行 (GitHub Actions)

## 開発

```bash
npm install
npm run dev      # ファイル監視で実行
npm run typecheck
```

Node.jsは nvm 経由でインストール済み (`~/.nvm`)。シェルを新規に開く場合は `nvm use --lts` が必要。

## 注意点

- `data/seen.json` は重複通知防止のための状態ファイル。GitHub Actions上で更新後に自動コミットされるため、ローカルでの不要なコミットに注意。
- 新しいRSSソースを追加する際は、実際にcurlでレスポンスを確認してからURLを追加すること(存在しないURLを推測で追加しない)。
