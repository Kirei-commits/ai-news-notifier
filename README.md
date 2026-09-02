# ai-news-notifier

AIの最新情報をRSSフィードから収集し、Discordに定期通知するアプリ。

## セットアップ

```bash
npm install
cp .env.example .env
# .env に DISCORD_WEBHOOK_URL と GEMINI_API_KEY を設定
npm start
```

### Gemini API Keyの取得方法

1. https://aistudio.google.com/apikey にアクセス(Googleアカウントでログイン)
2. 「Create API key」でキーを発行
3. `.env` の `GEMINI_API_KEY` に設定

見出しの日本語翻訳に使用します。無料枠内で利用可能です。`GEMINI_API_KEY` が未設定の場合は英語のまま通知されます。

### Discord Webhook URLの取得方法

1. Discordサーバーの通知したいチャンネルの設定を開く
2. 「連携サービス」→「ウェブフック」→「新しいウェブフック」
3. 表示されたURLをコピーして `.env` の `DISCORD_WEBHOOK_URL` に設定

## 情報源

`src/sources.ts` にRSSフィードの一覧を定義しています。追加・削除で通知対象を調整できます。

## 定期実行 (GitHub Actions)

`.github/workflows/notify.yml` が6時間ごとに自動実行します。

1. GitHubにリポジトリを作成しこのコードをpush
2. リポジトリの Settings → Secrets and variables → Actions で `DISCORD_WEBHOOK_URL` と `GEMINI_API_KEY` を登録
3. Actionsタブから手動実行 (workflow_dispatch) して動作確認

既知の記事は `data/seen.json` に記録し、重複通知を防いでいます(ワークフローが自動でコミットします)。

## エージェントハーネス (学習用)

`src/harness/` に、このリポジトリを題材にした自作エージェントハーネスがあります。
設計と学習計画は [docs/harness-engineering/README.md](docs/harness-engineering/README.md) を参照。

```bash
npm test                                # ハーネスのユニットテスト (API不要)
npm run eval                            # 評価スイート (モック実行・API不要)
npm run agent -- "今日のAIニュースをまとめてDiscordに投稿して"   # 既定は dry-run
```

定期通知の本体 (`npm start`) はこのハーネスとは独立して動きます。
