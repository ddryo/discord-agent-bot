# 実装ロードマップ

## マイルストーン構成

| マイルストーン | 内容 |
|----------|------|
| M1 | 最小動作（メッセージ送受信） |
| M2 | マルチセッション（スレッド対応） |
| M3 | インタラクション（通知・応答） |
| M4 | 安定化 |


## M1: 最小動作（メッセージ送受信）

| タスクID | 状態 | 依存タスク | 対応要件 | 概要 |
|----|------|------|--------|--------|
| T-M1-1 | ✅ | - | - | プロジェクト初期化（Bun + TypeScript + discord.js） |
| T-M1-2 | ✅ | T-M1-1 | - | 環境変数・設定モジュール（config.ts） |
| T-M1-3 | ✅ | T-M1-1 | - | ログ出力モジュール（logger.ts） |
| T-M1-4 | ✅ | T-M1-1 | - | 型定義（types.ts） |
| T-M1-5 | ✅ | T-M1-2 | FR-002 | tmux セッション管理（tmux/manager.ts） |
| T-M1-6 | ✅ | T-M1-5 | FR-004 | 出力パーサー（tmux/parser.ts）-- ANSI 除去・基本パターン検出 |
| T-M1-7 | ✅ | T-M1-5, T-M1-6 | FR-003 | 出力監視（tmux/watcher.ts）-- ポーリング・差分検出 |
| T-M1-8 | ✅ | T-M1-2 | - | Discord クライアント初期化（bot/client.ts） |
| T-M1-9 | ✅ | T-M1-8, T-M1-5 | FR-001 | メッセージ受信・振り分け（bot/handler.ts） |
| T-M1-10 | ✅ | T-M1-8, T-M1-7 | FR-001, FR-018 | Discord 投稿（bot/responder.ts）-- 分割・整形 |
| T-M1-11 | ✅ | T-M1-5 | FR-005 | セッション状態管理（sessions/store.ts）-- メインセッション |
| T-M1-12 | ✅ | T-M1-9, T-M1-10, T-M1-11 | FR-001, FR-005 | エントリーポイント統合（index.ts）-- 全モジュール結合・E2E 動作確認 |

### マイルストーン達成条件
- [x] チャンネルにメッセージを送ると、Claude の応答が Discord に返ってくる
- [x] メインセッション（ccbot-main）が自動起動する
- [x] ANSI エスケープが除去されたクリーンなテキストが投稿される

### 実装メモ
- 出力監視は capture-pane ポーリング方式を採用（pipe-pane 方式は不採用）
- OutputWatcher は EventEmitter ベースで `"output"` イベントを発火し、イベント種別は `OutputEvent.type` で判定
- メッセージ分割はコードブロック（```）の途中切断を回避するロジックを実装済み
- `.env.example` は作成済み（DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_USER_ID, DEFAULT_CWD, POLL_INTERVAL_MS を記載）


## M2: マルチセッション（スレッド対応）

| タスクID | 状態 | 依存タスク | 対応要件 | 概要 |
|----|------|------|--------|--------|
| T-M2-1 | ✅ | T-M1-11 | FR-006 | スレッド作成 --> 新規 tmux セッション起動 |
| T-M2-2 | ✅ | T-M2-1 | FR-006 | スレッド内メッセージ --> 対応セッションに振り分け |
| T-M2-3 | ✅ | T-M2-2 | FR-007 | 複数セッションの並列ポーリング・動作検証 |

### マイルストーン達成条件
- [x] スレッド作成時にスレッドタイトルを cwd とした Claude セッションが起動する
- [x] スレッドごとに独立した Claude セッションが並列動作する
- [x] パスが存在しない場合はエラー通知される

### 実装メモ
- OutputWatcher は Map<string, WatcherEntry> で各セッションを独立管理し、並列ポーリングに対応
- SessionStore に getSessionByName() を追加し、sessionName → threadId の逆引きを実現
- index.ts の output イベントハンドラで sessionName に基づいてメインチャンネル/スレッドへ正しくルーティング
- threadCreate イベントで自動的にセッション作成・監視開始・SessionStore 登録を実施
- handler.ts の handleThreadCreate でスレッドタイトルを expandTilde + resolve でパス解釈し、statSync で存在・ディレクトリ判定
- handleThreadMessage はスレッドの parentId を検証し、対象チャンネルの子スレッドのみ処理する
- client.ts に ThreadCreateHandler 型と onThreadCreate イベント登録を追加


## M3: インタラクション（通知・応答）

| タスクID | 状態 | 依存タスク | 対応要件 | 概要 |
|----|------|------|--------|--------|
| T-M3-1 | ✅ | T-M1-6 | FR-004 | パーサーにツール許可・AskUser 検出パターンを追加 |
| T-M3-2 | ✅ | T-M3-1 | FR-008 | ツール許可通知（Embed + ボタン）・応答処理 |
| T-M3-3 | ✅ | T-M3-1 | FR-009 | AskUserQuestion 通知・応答処理 |
| T-M3-4 | ✅ | T-M1-9 | FR-010, FR-011 | CLI コマンド対応（/clear, /compact 等） |
| T-M3-5 | ✅ | T-M1-9 | FR-012 | /exit コマンド対応（セッション手動終了） |

### マイルストーン達成条件
- [x] ツール許可待ちが Embed + ボタンで通知され、ボタン応答で CLI に送信される
- [x] AskUserQuestion が通知され、選択肢ボタンまたはテキストで応答できる
- [x] /clear 実行時に Discord に区切りメッセージが挿入される
- [x] /exit でセッションが終了する

### 実装メモ
- パーサーの検出優先順位は `tool_approval` > `ask_user` > `session_end` > `idle` > `text`
- `detectToolApproval()`: `"Do you want to proceed?"` + `"Tool: XXX"` パターンでツール名・説明・選択肢を抽出
- `detectAskUser()`: `"?"` 行 + `"(Use arrow keys or type your choice)"` で質問・選択肢を抽出
- `bot/interactions.ts` が Embed + ボタン送信・ボタン応答処理・テキスト返答処理を一括管理
- `pendingInteractions` Map でセッションごとの待機状態（`"tool_approval"` / `"ask_user"`）を管理し、テキスト入力の AskUser 返答を判定に利用
- `client.ts` に `InteractionHandler` 型と `onInteraction` を追加し、`interactionCreate` イベントを `index.ts` から登録
- `handler.ts` の `handleCommand()` で `/` コマンドを分岐処理、`handleExitCommand()` で killSession → removeSession → watcher.unwatch → 終了 Embed を投稿
- `setWatcher()` で index.ts から watcher 参照を handler に渡す設計


## M4: 安定化

| タスクID | 状態 | 依存タスク | 対応要件 | 概要 |
|----|------|------|--------|--------|
| T-M4-1 | ⬜ | T-M2-3 | FR-014 | エラーハンドリング（セッション死亡検知・通知） |
| T-M4-2 | ⬜ | T-M4-1 | FR-015 | グレースフルシャットダウン（SIGINT/SIGTERM） |
| T-M4-3 | ⬜ | T-M1-5 | FR-016 | 起動時ヘルスチェック（tmux・Claude CLI 存在確認） |
| T-M4-4 | ⬜ | T-M1-10 | FR-018 | 長時間出力・大量出力への対策 |
| T-M4-5 | ⬜ | T-M1-9 | FR-017 | 操作ユーザー制限の実装 |
| T-M4-6 | ⬜ | T-M1-6 | FR-013 | セッション起動/終了通知 |

### マイルストーン達成条件
- [ ] セッションが異常終了した場合に Discord に通知される
- [ ] Bot 終了時に全 tmux セッションがクリーンアップされる
- [ ] tmux / Claude CLI 未インストール時に分かりやすいエラーメッセージが出る
- [ ] 2000 文字超の応答が正しく分割投稿される
