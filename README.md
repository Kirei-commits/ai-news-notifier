# ai-news-notifier

AIの最新情報をRSSフィードから収集し、Discordに定期通知するアプリ。

## セットアップ

```bash
npm install
cp .env.example .env
# .env に DISCORD_WEBHOOK_URL を設定
npm start
```

### Discord Webhook URLの取得方法

1. Discordサーバーの通知したいチャンネルの設定を開く
2. 「連携サービス」→「ウェブフック」→「新しいウェブフック」
3. 表示されたURLをコピーして `.env` の `DISCORD_WEBHOOK_URL` に設定

## 情報源

`src/sources.ts` にRSSフィードの一覧を定義しています。追加・削除で通知対象を調整できます。

## 定期実行 (GitHub Actions)

`.github/workflows/notify.yml` が6時間ごとに自動実行します。

1. GitHubにリポジトリを作成しこのコードをpush
2. リポジトリの Settings → Secrets and variables → Actions で `DISCORD_WEBHOOK_URL` を登録
3. Actionsタブから手動実行 (workflow_dispatch) して動作確認

既知の記事は `data/seen.json` に記録し、重複通知を防いでいます(ワークフローが自動でコミットします)。
