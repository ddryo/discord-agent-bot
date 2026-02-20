# タスクアーカイブ

完了したタスクの履歴。

## M1: 最小動作（メッセージ送受信）（2026-02-19 完了）

- T-M1-1: プロジェクト初期化（Bun + TypeScript + discord.js）
- T-M1-2: 環境変数・設定モジュール（config.ts）
- T-M1-3: ログ出力モジュール（logger.ts）
- T-M1-4: 型定義（types.ts）
- T-M1-5: tmux セッション管理（tmux/manager.ts）
- T-M1-6: 出力パーサー（tmux/parser.ts）-- ANSI 除去・基本パターン検出
- T-M1-7: 出力監視（tmux/watcher.ts）-- ポーリング・差分検出
- T-M1-8: Discord クライアント初期化（bot/client.ts）
- T-M1-9: メッセージ受信・振り分け（bot/handler.ts）
- T-M1-10: Discord 投稿（bot/responder.ts）-- 分割・整形
- T-M1-11: セッション状態管理（sessions/store.ts）-- メインセッション
- T-M1-12: エントリーポイント統合（index.ts）-- 全モジュール結合・E2E 動作確認

### 実装メモ
- 出力監視は capture-pane ポーリング方式を採用（pipe-pane 方式は不採用）
- OutputWatcher は EventEmitter ベースで `"output"` イベントを発火し、イベント種別は `OutputEvent.type` で判定
- メッセージ分割はコードブロック（```）の途中切断を回避するロジックを実装済み

---

## M2: マルチセッション（スレッド対応）（2026-02-19 完了）

- T-M2-1: スレッド作成 --> 新規 tmux セッション起動
- T-M2-2: スレッド内メッセージ --> 対応セッションに振り分け
- T-M2-3: 複数セッションの並列ポーリング・動作検証

### 実装メモ
- OutputWatcher は Map<string, WatcherEntry> で各セッションを独立管理し、並列ポーリングに対応
- SessionStore に getSessionByName() を追加し、sessionName → threadId の逆引きを実現
- handleThreadCreate はタイトルのパス解析を行わず、常にデフォルト cwd でセッション起動
- `/new` 経由で作成済みのスレッドは handleThreadCreate で二重起動しないようガード

---

## M3: インタラクション（通知・応答）（2026-02-19 完了）

- T-M3-1: パーサーにツール許可・AskUser 検出パターンを追加
- T-M3-2: ツール許可通知（Embed + ボタン）・応答処理
- T-M3-3: AskUserQuestion 通知・応答処理
- T-M3-4: CLI コマンド対応（/clear, /compact 等）
- T-M3-5: /exit コマンド対応（セッション手動終了）

### 実装メモ
- パーサーの検出優先順位は `tool_approval` > `ask_user` > `session_end` > `idle` > `text`
- `bot/interactions.ts` が Embed + ボタン送信・ボタン応答処理・テキスト返答処理を一括管理
- `pendingInteractions` Map でセッションごとの待機状態を管理
- `handler.ts` の `handleCommand()` で `/` コマンドを分岐処理

---

## M4: 安定化（2026-02-20 完了）

- T-M4-1: エラーハンドリング（セッション死亡検知・通知）
- T-M4-2: グレースフルシャットダウン（SIGINT/SIGTERM）
- T-M4-3: 起動時ヘルスチェック（tmux・Claude CLI 存在確認）
- T-M4-4: 長時間出力・大量出力への対策
- T-M4-5: 操作ユーザー制限の実装
- T-M4-6: セッション起動/終了通知

### 実装メモ
- OutputWatcher の `poll()` で `capturePane` 失敗時に `hasSession()` でセッション死亡を検知し、`session_dead` イベントを発火
- `gracefulShutdown()` で `watcher.unwatchAll()` → 全セッション kill → `discord.destroy()` を順次実行
- `checkDependencies()` で `tmux -V`、`claude --version` を `Bun.spawn` で実行
- `sendToDiscord()` に rate limit 対策を追加（429 レスポンス時のリトライ、連続投稿チャンク間の 500ms 遅延）
- `isAuthorizedUser()` で操作ユーザー制限。未許可ユーザーのボタン応答はエフェメラルメッセージで拒否
- 正常終了（青）、異常終了（赤）、手動終了（黄）、起動（緑）で色分け通知

---

## M5: セッション作成の改善（2026-02-20 完了）

- T-M5-1: `/new` スラッシュコマンドの定義追加（commands.ts）
- T-M5-2: `/new` コマンドの処理実装（handler.ts）-- スレッド作成 + セッション起動
- T-M5-3: `handleThreadCreate` の簡略化 -- パス解析ロジック廃止、常に defaultCwd で起動
- T-M5-4: `/new` 経由スレッドの二重起動防止ガード
- T-M5-5: 動作検証 -- 手動スレッド作成・`/new` コマンド・パスバリデーション

### 実装メモ
- `commands.ts` に `/new` コマンドを `SlashCommandBuilder` で定義。`title`（required）と `path`（optional）オプション
- `path` 指定時は `expandTilde` + `resolve` + `BLOCKED_PATHS` チェック + `stat` ディレクトリ確認を実施
- `handleThreadCreate` からパス解析ロジックを削除。常に `config.defaultCwd` でセッション起動
- `handleThreadCreate` 冒頭の `getSessionByThreadId` チェックが二重起動防止ガードとして機能
