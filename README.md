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

## 開発コマンド

```bash
npm run lint          # ESLint (型情報つき)
npm run lint:fix      # 自動修正
npm run format        # Prettier で整形
npm run format:check  # 整形済みか検査
npm run typecheck     # tsc --noEmit (テストも対象)
npm test              # Vitest
npm run test:coverage # カバレッジ閾値つき
npm run build         # dist/ へコンパイル (テストは除外)
```

## CI/CD

`.github/workflows/` に3本のワークフローがあります。すべてパブリックリポジトリの無料枠で動きます。

### `ci.yml` — push / PR で実行

| ジョブ              | 内容                                                                              |
| ------------------- | --------------------------------------------------------------------------------- |
| `quality`           | Prettier / ESLint / TypeScript                                                    |
| `test`              | Vitest を Node 22・24 のマトリクスで実行。カバレッジ閾値(lines 80%)を下回ると失敗 |
| `build`             | `tsc` でコンパイルが通ることを確認                                                |
| `audit`             | `npm audit --audit-level=high`                                                    |
| `dependency-review` | PR で追加された依存の脆弱性・ライセンスを審査                                     |
| `actionlint`        | ワークフロー定義自体を lint                                                       |
| `sonar`             | SonarQube Cloud 解析(下記セットアップ後に有効)                                    |
| `container`         | Docker イメージをビルドし Trivy でスキャン。`main` のみ GHCR へ push              |

### `codeql.yml` — GitHub 純正の静的解析

`security-and-quality` クエリで週次 + push/PR 時に解析します。結果は Security タブの Code scanning に出ます。

### `security.yml` — Trivy によるリポジトリスキャン

依存の脆弱性・シークレット混入・設定ミスを週次 + push/PR で検査します。

### Dependabot

`.github/dependabot.yml` で npm と GitHub Actions を毎週更新します。PR が乱立しないよう
dev/prod・minor/patch でグループ化しています。

### SonarQube Cloud のセットアップ

パブリックリポジトリは無料です。有効化するまで `sonar` ジョブはスキップされます(CI は失敗しません)。

1. https://sonarcloud.io に GitHub アカウントでログイン
2. 対象リポジトリを import し、Analysis Method を **CI-based** に設定
3. 発行されたトークンを GitHub の Settings → Secrets and variables → Actions に
   `SONAR_TOKEN` として登録
4. `sonar-project.properties` の `sonar.organization` / `sonar.projectKey` を
   SonarQube 上の実際の値に合わせる

### コンテナ

```bash
docker build -t ai-news-notifier .
docker run --rm --env-file .env -v "$PWD/data:/app/data" ai-news-notifier
```

`main` への push で `ghcr.io/kirei-commits/ai-news-notifier` に公開されます。
`data/` は `seen.json` の書き込み先なのでボリュームをマウントしてください。

### Kubernetes を使っていない理由

このアプリは「起動 → RSS取得 → Discord投稿 → 終了」で完結するバッチで、常駐するプロセスがありません。
そのため k8s に載せる利点がほとんどない一方、マネージド k8s はコントロールプレーンだけで
各社 $0.10/時(約$72/月)、ノード込みの最小構成で月$85〜185ほどかかります。
現状の GitHub Actions の cron は無料で同じ役割を果たすため、採用していません。

将来どうしても常駐させたくなった場合は、上記の GHCR イメージをそのまま
`CronJob` として使えます(イメージは k8s 前提で作ってあります)。
