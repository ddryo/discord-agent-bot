# 実装ロードマップ

## マイルストーン構成

| マイルストーン | 内容 |
|----------|------|
| M1 | 最小動作（メッセージ送受信） |
| M2 | マルチセッション（スレッド対応） |
| M3 | インタラクション（通知・応答） |
| M4 | 安定化 |
| M5 | セッション作成の改善 |


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
- [x] スレッド作成時にデフォルト cwd で Claude セッションが起動する
- [x] スレッドごとに独立した Claude セッションが並列動作する
- [x] `/new` コマンドで任意の cwd を指定してスレッド+セッションを作成できる（M5 で実装）

### 実装メモ
- OutputWatcher は Map<string, WatcherEntry> で各セッションを独立管理し、並列ポーリングに対応
- SessionStore に getSessionByName() を追加し、sessionName → threadId の逆引きを実現
- index.ts の output イベントハンドラで sessionName に基づいてメインチャンネル/スレッドへ正しくルーティング
- threadCreate イベントで自動的にセッション作成・監視開始・SessionStore 登録を実施（cwd は常に config.defaultCwd）
- handleThreadCreate はタイトルのパス解析を行わず、常にデフォルト cwd でセッション起動。スレッドタイトルは純粋に表示用（M5 で確定した設計）
- `/new` 経由で作成済みのスレッドは handleThreadCreate で二重起動しないようガード（SessionStore 既登録チェック。M5 で実装）
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
| T-M4-1 | ✅ | T-M2-3 | FR-014 | エラーハンドリング（セッション死亡検知・通知） |
| T-M4-2 | ✅ | T-M4-1 | FR-015 | グレースフルシャットダウン（SIGINT/SIGTERM） |
| T-M4-3 | ✅ | T-M1-5 | FR-016 | 起動時ヘルスチェック（tmux・Claude CLI 存在確認） |
| T-M4-4 | ✅ | T-M1-10 | FR-018 | 長時間出力・大量出力への対策 |
| T-M4-5 | ✅ | T-M1-9 | FR-017 | 操作ユーザー制限の実装 |
| T-M4-6 | ✅ | T-M1-6 | FR-013 | セッション起動/終了通知 |

### マイルストーン達成条件
- [x] セッションが異常終了した場合に Discord に通知される
- [x] Bot 終了時に全 tmux セッションがクリーンアップされる
- [x] tmux / Claude CLI 未インストール時に分かりやすいエラーメッセージが出る
- [x] 2000 文字超の応答が正しく分割投稿される
- [x] DISCORD_USER_ID による操作ユーザー制限が機能する
- [x] セッション起動/終了時にステータス通知が投稿される

### 実装メモ
- **T-M4-1（エラーハンドリング）**: OutputWatcher の `poll()` で `capturePane` 失敗時に `hasSession()` でセッション死亡を検知し、`session_dead` イベントを発火。index.ts で `session_dead` / `session_end` イベントをハンドリングし、Discord 通知 + クリーンアップ（SessionStore 削除、watcher.unwatch、pendingInteraction クリア）を実施。`process.on('unhandledRejection'/'uncaughtException')` でプロセスクラッシュを防止
- **T-M4-2（グレースフルシャットダウン）**: `gracefulShutdown()` で `watcher.unwatchAll()` → `listSessions()` で全 `ccbot-` セッションを kill → `discord.destroy()` を順次実行。`isShuttingDown` フラグで二重実行を防止。SIGINT / SIGTERM の両方に対応
- **T-M4-3（起動時ヘルスチェック）**: `checkDependencies()` で `tmux -V`、`claude --version` を `Bun.spawn` で実行し、未インストール時は日本語エラーメッセージをスローして起動中断。正常時はバージョン情報をログ出力
- **T-M4-4（長時間出力・大量出力への対策）**: `capturePane` のデフォルトスクロールバック行数を 200 → 500 に拡大。`sendToDiscord()` に rate limit 対策を追加（429 レスポンス時のリトライ、連続投稿チャンク間の 500ms 遅延）
- **T-M4-5（操作ユーザー制限）**: `handler.ts` / `interactions.ts` に `isAuthorizedUser()` チェックを追加。未許可ユーザーのメッセージは無視、ボタン応答はエフェメラルメッセージで「権限がありません」と応答
- **T-M4-6（セッション起動/終了通知）**: `responder.ts` に `sendSessionStartNotification()` / `sendSessionEndNotification()` 共通関数を実装。正常終了（青）、異常終了（赤）、手動終了（黄）、起動（緑）で色分け通知


## M5: セッション作成の改善

| タスクID | 状態 | 依存タスク | 対応要件 | 概要 |
|----|------|------|--------|--------|
| T-M5-1 | ✅ | T-M2-1 | FR-019 | `/new` スラッシュコマンドの定義追加（commands.ts） |
| T-M5-2 | ✅ | T-M5-1 | FR-019 | `/new` コマンドの処理実装（handler.ts） -- スレッド作成 + セッション起動 |
| T-M5-3 | ✅ | T-M5-2 | FR-006 | `handleThreadCreate` の簡略化 -- パス解析ロジック廃止、常に defaultCwd で起動 |
| T-M5-4 | ✅ | T-M5-2, T-M5-3 | FR-006, FR-019 | `/new` 経由スレッドの二重起動防止ガード |
| T-M5-5 | ✅ | T-M5-4 | - | 動作検証 -- 手動スレッド作成・`/new` コマンド・パスバリデーション |

### マイルストーン達成条件
- [x] `/new` コマンドで `title` と `path` を指定してスレッド+セッションを作成できる
- [x] `/new` で `path` 省略時は DEFAULT_CWD でセッションが起動する
- [x] `/new` で指定した `path` の `BLOCKED_PATHS` チェックと `stat` ディレクトリ確認が動作する
- [x] 手動スレッド作成時に常に DEFAULT_CWD でセッションが起動する（タイトルをパスとして解釈しない）
- [x] `/new` 経由で作成したスレッドが `handleThreadCreate` で二重起動しない

### 実装メモ
- **T-M5-1**: `commands.ts` に `/new` コマンドを `SlashCommandBuilder` で定義。`title`（String, required）と `path`（String, optional）オプションを追加
- **T-M5-2**: `handler.ts` の `handleCommandInteraction` に `/new` の分岐を追加。`path` 指定時は `expandTilde` + `resolve` + `BLOCKED_PATHS` チェック + `stat` ディレクトリ確認を実施。チャンネルに `threads.create()` でスレッドを作成し、SessionManager にセッション登録、起動通知 Embed を投稿
- **T-M5-3**: `handleThreadCreate` から `expandTilde` + `resolve` + `stat` のパス解析ロジックを削除。常に `config.defaultCwd` でセッションを起動するように変更。スレッドタイトルは表示用のみ
- **T-M5-4**: `handleThreadCreate` 冒頭の `getSessionByThreadId` チェック（既存）が二重起動防止ガードとして機能する。`/new` 側でセッション登録後に threadCreate イベントが発火しても、既に登録済みのためスキップされる
- **影響ファイル**: `src/bot/commands.ts`, `src/bot/handler.ts`
