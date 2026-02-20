# プロジェクト仕様書

## 1. 概要

### 目的

Discord チャンネルから Claude Code CLI を操作する Bot を提供する。tmux 経由で Claude CLI の対話モードを制御し、Bot 単体で完結する（Claude Code 側の設定不要）。

### コンセプト

- 指定チャンネルへのメッセージ = Claude への送信（コマンド不要）
- スレッド = 独立した Claude セッション（並列動作可）
- tmux が Claude CLI のプロセス管理・入出力制御を担う

### 対象ユーザー

- Claude Code CLI を日常的に利用する開発者
- Discord をコミュニケーション基盤として使用しているチーム・個人


## 2. 機能要件

| ID | 機能名 | 説明 | 優先度 | MVP |
|----|--------|------|--------|-----|
| FR-001 | メッセージ送受信 | チャンネルのメッセージを Claude CLI に送信し、応答を Discord に投稿する | Must | o |
| FR-002 | tmux セッション管理 | Claude CLI プロセスを tmux セッションとして作成・破棄・制御する | Must | o |
| FR-003 | 出力監視 | tmux の出力を capture-pane ポーリングで監視し、差分を検出する | Must | o |
| FR-004 | 出力パース | raw テキストを正規化イベント（text / tool_approval / ask_user / idle / session_end / error）に変換する | Must | o |
| FR-005 | メインセッション | メインチャンネルに紐づく常駐 Claude セッション（cwd: DEFAULT_CWD） | Must | o |
| FR-006 | スレッドセッション | スレッド作成時にデフォルト cwd でセッションを起動し、スレッド内メッセージを振り分ける。`/new` コマンドで任意の cwd を指定可能 | Must | o |
| FR-007 | 複数セッション並列動作 | 複数スレッドの Claude セッションが同時に稼働する | Must | o |
| FR-008 | ツール許可通知 | ツール実行許可待ちを Embed + ボタン（Approve / Deny / AlwaysAllow）で通知し、応答を CLI に送信する | Must | o |
| FR-009 | AskUserQuestion 通知 | AskUserQuestion を質問 + 選択肢ボタンで通知し、テキスト返答も受け付ける | Must | o |
| FR-010 | CLI コマンド転送 | `/clear`, `/compact`, `/cost`, `/context`, `/status`, `/model` を Claude CLI に送信する | Must | o |
| FR-011 | /clear 特別処理 | `/clear` 実行時に Discord スレッドに区切りメッセージを挿入する | Must | o |
| FR-012 | /exit コマンド | tmux セッションを手動終了する | Must | o |
| FR-013 | セッション起動/終了通知 | セッションの起動・終了時にステータスメッセージを投稿する | Should | - |
| FR-014 | エラーハンドリング | セッション死亡検知・通知、予期しないエラーのリカバリ | Should | - |
| FR-015 | グレースフルシャットダウン | SIGINT/SIGTERM 受信時に全 tmux セッションを終了する | Should | - |
| FR-016 | 起動時ヘルスチェック | Bot 起動時に tmux・Claude CLI の存在を確認する | Should | - |
| FR-017 | 操作ユーザー制限 | DISCORD_USER_ID が設定されている場合、そのユーザーのみ操作を許可する | Should | - |
| FR-018 | Discord メッセージ分割 | 2000 文字制限を考慮した分割投稿（コードブロック途中切断の回避） | Should | - |
| FR-019 | /new スラッシュコマンド | `title`（必須）と `path`（任意）を引数に取り、チャンネルにスレッドを作成してセッションを起動する | Must | - |

**優先度**: Must（必須）/ Should（推奨）/ Could（任意）


## 3. 技術スタック

| カテゴリ | 技術 | 選定理由 |
|----------|------|----------|
| ランタイム | Bun | 高速な起動・実行、TypeScript ネイティブサポート、組み込みテストランナー |
| 言語 | TypeScript | 型安全性、開発効率 |
| Discord ライブラリ | discord.js | Node.js/Bun 向け Discord API ライブラリのデファクトスタンダード |
| プロセス制御 | tmux | セッション管理、入出力制御、バックグラウンド実行が可能 |
| CLI | Claude Code CLI (claude) | 対話モードで AskUserQuestion 応答・ツール許可・スラッシュコマンドに対応 |


## 4. アーキテクチャ

### ディレクトリ構成

```
discord-agent-bot/
├── src/
│   ├── index.ts              # エントリーポイント                    [M1]
│   ├── config.ts             # 環境変数・設定                        [M1]
│   ├── logger.ts             # ログ出力                              [M1]
│   ├── types.ts              # 型定義                                [M1]
│   ├── tmux/
│   │   ├── manager.ts        # tmux セッション CRUD・入出力          [M1]
│   │   ├── watcher.ts        # 出力監視（capture-pane ポーリング）   [M1]
│   │   └── parser.ts         # ANSI 除去・パターン検出・イベント変換 [M1]
│   ├── bot/
│   │   ├── client.ts         # Discord クライアント初期化・イベント登録 [M1]
│   │   ├── commands.ts       # スラッシュコマンド定義・登録             [M3]
│   │   ├── handler.ts        # メッセージ受信 → セッション振り分け   [M1]
│   │   ├── responder.ts      # Claude 出力 → Discord 投稿（分割・整形）[M1]
│   │   └── interactions.ts   # ツール許可・AskUser のボタン通知・応答処理 [M3]
│   └── sessions/
│       └── store.ts          # threadId <-> tmux セッションの対応管理 [M1]
├── docs/
├── tests/
└── .env
```

### コンポーネント構成

```
Discord チャンネル (DISCORD_CHANNEL_ID)
|
+-- メッセージ ----------> メイン tmux セッション (ccbot-main, cwd: DEFAULT_CWD)
|   +-- Claude 応答 <---- 出力監視 (capture-pane ポーリング)
|
+-- /new title:"機能A開発" path:~/projects/app
|   +-- スレッド「機能A開発」 -----> tmux セッション (ccbot-<threadId>, cwd: ~/projects/app)
|   +-- メッセージ --> send-keys
|   +-- Claude 応答 <---- 出力監視
|
+-- 手動スレッド「バグ修正メモ」 --> tmux セッション (ccbot-<threadId>, cwd: DEFAULT_CWD)
|   +-- メッセージ --> send-keys
|   +-- Claude 応答 <---- 出力監視
|
+-- ...
```

### 通信フロー

```
[Discord メッセージ受信 / スラッシュコマンド受信]
  |
  v
[操作ユーザー制限チェック（DISCORD_USER_ID 設定時）]
  |
  +-- 未許可ユーザー --> 無視（ボタン応答はエフェメラルで権限なしメッセージ）
  |
  v
[スラッシュコマンド判定]
  |
  +-- /new --> パスバリデーション → スレッド作成 → セッション登録 → 起動通知
  +-- /clear, /status, /tools --> 対応処理
  |
  v
[テキストコマンド判定（/ で始まるか）]
  |
  +-- コマンド --+
  |              |
  |   +-- /exit --> killSession → removeSession → watcher.unwatch → 終了通知 Embed
  |   +-- /clear, /compact 等 --> send-keys で CLI に送信（/clear は区切り Embed を追加投稿）
  |   +-- 未対応コマンド --> エラーメッセージ返信
  |
  +-- 通常メッセージ --+
  |                    |
  |   +-- AskUser 待ちの場合 --> handleAskUserTextResponse → send-keys でテキスト送信
  |   +-- それ以外 --> セッション特定（なければ作成）→ tmux send-keys で Claude CLI に入力
  |
  v
[出力監視で差分検出]
  |
  +-- 通常テキスト --> Discord に投稿（rate limit 対策付き）
  +-- ツール許可待ち --> ボタン付き Embed --> ユーザー応答 --> send-keys
  +-- AskUserQuestion --> 質問 + ボタン/テキスト --> ユーザー応答 --> send-keys
  +-- アイドル --> 待機
  +-- セッション終了 --> 終了通知 Embed + クリーンアップ
  +-- セッション死亡 --> エラー通知 Embed + クリーンアップ（capturePane 失敗 → hasSession で検知）

[スレッド作成イベント（threadCreate）]
  |
  +-- /new 経由で既にセッション登録済み --> スキップ（二重起動防止）
  +-- 手動作成 --> DEFAULT_CWD でセッション登録 → 起動通知
```

### パーサーのイベント層（FR-004）

raw テキストからドメインイベントへの変換を分離し、Claude CLI のフォーマット変更時の修正を局所化する。

| イベント種別 | 説明 |
|-------------|------|
| `text` | 通常のテキスト出力 |
| `tool_approval` | ツール実行許可待ち |
| `ask_user` | AskUserQuestion |
| `idle` | 入力待ちプロンプト |
| `session_end` | セッション終了 |
| `error` | エラー検出 |

**検出優先順位**: `tool_approval` > `ask_user` > `session_end` > `idle` > `text`

**OutputWatcher レベルのイベント**:

上記のパーサーイベントとは別に、OutputWatcher が直接発火するイベントがある。

| イベント | 説明 |
|----------|------|
| `session_dead` | capturePane 失敗時に hasSession() でセッション死亡を検知した場合に発火。パーサーを経由しない |

**検出パターン詳細**:

| 検出関数 | 検出条件 | 備考 |
|----------|----------|------|
| `detectToolApproval()` | `"Do you want to proceed?"` + `"Tool: XXX"` パターン | ツール名・説明文・選択肢を抽出 |
| `detectAskUser()` | `"?"` で始まる質問行 + `"(Use arrow keys or type your choice)"` | 質問文・選択肢を抽出 |
| `detectSessionEnd()` | 末尾5行に `"Goodbye!"` / `"Session ended."` / `"Exiting..."` | 行全体一致で誤検知防止 |
| `detectIdlePrompt()` | 末尾行が `>` プロンプト（ボックスドロー文字付き含む） | 正規表現: `/^[╰└\-─]*\s*>\s*$/` |

`tool_approval` / `ask_user` は単一イベントとして返し、`session_end` / `idle` はテキスト本文と状態イベントの2つに分離して返す。

### 出力監視方式

M1 の実装時に検討した結果、**capture-pane ポーリング方式** を採用した。

| 方式 | 仕組み | メリット | デメリット | 採用 |
|------|--------|----------|------------|------|
| capture-pane ポーリング | 定期的に `tmux capture-pane -p` を実行し差分比較 | 実装がシンプル | ポーリング間隔分の遅延、差分検出の複雑さ | **採用** |
| pipe-pane + fs.watch | `tmux pipe-pane` でファイルにストリーム出力し `fs.watch` で監視 | イベント駆動で低遅延 | ファイル管理が必要、バイナリ出力の扱いが煩雑 | 不採用 |

差分検出は、前回キャプチャの末尾行群と今回の出力を照合し、一致位置以降を新規差分とする方式で実装している。


## 5. インターフェース

### tmux セッション管理 API

tmux コマンドの実行には `Bun.spawn` の引数配列形式を使用し、シェル文字列結合を行わない（インジェクション対策）。セッション名には `ccbot-` プレフィックスが自動付与される。

| 操作 | tmux コマンド | 説明 |
|------|--------------|------|
| セッション作成 | `tmux new-session -d -s {name} -c {cwd} -- claude` | Claude CLI を起動するセッションを作成 |
| セッション破棄 | `tmux kill-session -t {name}` | セッションを終了 |
| テキスト入力 | `tmux send-keys -t {name} -l -- {text}` + `send-keys Enter` | Claude CLI にテキストを送信 |
| 特殊キー送信 | `tmux send-keys -t {name} {keys}` | Escape, Up 等の特殊キー |
| 画面キャプチャ | `tmux capture-pane -p -t {name} -S -{lines}` | 出力テキストを取得（デフォルト 500 行） |
| セッション確認 | `tmux has-session -t {name}` | セッションの存在確認 |
| セッション一覧 | `tmux list-sessions -F "#{session_name}"` | ccbot- プレフィックスでフィルタ |

### セッション命名規則

| 種別 | セッション名 | cwd |
|------|-------------|-----|
| メインチャンネル | `ccbot-main` | DEFAULT_CWD（デフォルト: `~/Desktop`） |
| スレッド（手動作成） | `ccbot-{threadId}` | DEFAULT_CWD |
| スレッド（`/new` で作成） | `ccbot-{threadId}` | `/new` の `path` 引数（省略時は DEFAULT_CWD） |

### Discord インタラクション

インタラクション状態は `pendingInteractions` Map（`bot/interactions.ts`）でセッションごとに管理する。値は `"tool_approval"` | `"ask_user"` のいずれか。ボタン応答またはテキスト返答後にクリアされる。

**ツール許可待ち（FR-008）**

| ボタン | customId | 送信値 |
|--------|----------|--------|
| Approve | `tool_approve:{sessionName}` | `"1"` |
| Always Allow | `tool_always:{sessionName}` | `"2"` |
| Deny | `tool_deny:{sessionName}` | `"3"` |

- Embed のタイトル: `Tool: {ツール名}`、説明にツールの引数をコードブロックで表示
- 応答後はボタンを disabled に更新し、選択結果と操作ユーザーを表示

**AskUserQuestion（FR-009）**

| 応答方式 | customId / トリガー | 送信値 |
|----------|---------------------|--------|
| ボタン選択 | `askuser_{n}:{sessionName}` | `"{n}"` （選択肢番号） |
| テキスト返答 | handler.ts で AskUser 待ち判定 | メッセージ内容をそのまま send-keys |

- Embed のタイトル: `Question`、説明に質問文を表示
- 選択肢がある場合はボタンを表示（最大5個/行、ActionRow は最大5行）
- ボタン・テキストどちらでも応答可（フッターで案内）

**スレッド作成コマンド（FR-019）**

| 引数 | 必須 | 説明 |
|------|------|------|
| `title` | o | スレッドタイトル（表示用、パスとして解釈しない） |
| `path` | - | セッションの cwd。省略時は DEFAULT_CWD |

処理フロー:
1. `path` が指定されている場合: `BLOCKED_PATHS` チェック + `stat` によるディレクトリ存在確認
2. チャンネルにスレッドを作成（タイトル: `title`）
3. セッションを登録・起動（cwd: 検証済みの `path` または DEFAULT_CWD）
4. 起動通知 Embed をスレッドに投稿
5. `/new` 経由で作成したスレッドは `handleThreadCreate` 側で二重起動しないようガード（SessionStore に既に登録済みかで判定）

**CLI コマンド（FR-010, FR-011, FR-012）**

| コマンド | 処理 |
|----------|------|
| `/clear` | CLI に送信 + 区切り Embed（`--- Context Cleared ---`）を返信 |
| `/compact`, `/cost`, `/context`, `/status`, `/model` | CLI にそのまま送信 |
| `/exit` | `killSession` → `removeSession` → `watcher.unwatch` → `clearPendingInteraction` → 終了通知 Embed を返信 |
| その他 | `未対応のコマンドです` エラーメッセージを返信 |

**セッション起動/終了通知（FR-013）**

`responder.ts` の共通関数で Embed を投稿する。メイン・スレッドセッション両対応。

| 通知種別 | 関数 | Embed 色 | 説明 |
|----------|------|----------|------|
| 起動 | `sendSessionStartNotification()` | 緑 (`0x57f287`) | セッション名と作業ディレクトリを表示 |
| 正常終了 | `sendSessionEndNotification(channel, "normal")` | 青 (`0x5865f2`) | `session_end` イベント検知時 |
| 異常終了 | `sendSessionEndNotification(channel, "error")` | 赤 (`0xed4245`) | `session_dead` イベント検知時 |
| 手動終了 | `sendSessionEndNotification(channel, "exit")` | 黄 (`0xfee75c`) | `/exit` コマンド実行時 |

**Discord 投稿の rate limit 対策（FR-018）**

`sendToDiscord()` で以下の対策を実施する。

| 対策 | 説明 |
|------|------|
| 429 リトライ | Discord API の 429 レスポンス時に `retryAfter` 値を待ってからリトライ（1 回まで） |
| 連続投稿遅延 | 分割投稿時、チャンク間に 500ms の遅延を挿入して rate limit を予防 |

**操作ユーザー制限（FR-017）**

`DISCORD_USER_ID` が設定されている場合、以下のチェックを行う。

| チェック対象 | 挙動 |
|-------------|------|
| メッセージ（handler.ts） | 未許可ユーザーのメッセージは無視（応答しない） |
| ボタン応答（interactions.ts） | エフェメラルメッセージで「権限がありません」を表示 |

**エラーハンドリング・安定化（FR-014, FR-015, FR-016）**

| 機能 | 説明 |
|------|------|
| セッション死亡検知 | OutputWatcher の poll() で capturePane 失敗時に `hasSession()` でセッション生存を確認し、死亡時に `session_dead` イベントを発火 |
| グレースフルシャットダウン | SIGINT/SIGTERM 受信時に `watcher.unwatchAll()` → 全 `ccbot-` セッション kill → `discord.destroy()` を順次実行。`isShuttingDown` フラグで二重実行を防止 |
| 起動時ヘルスチェック | `checkDependencies()` で `tmux -V` / `claude --version` を確認。未インストール時はエラーメッセージをスローして起動中断 |
| クラッシュ防止 | `process.on('unhandledRejection'/'uncaughtException')` でプロセスクラッシュを防止し、エラーログを出力 |

### 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| DISCORD_BOT_TOKEN | o | - | Discord Bot トークン |
| DISCORD_CHANNEL_ID | o | - | 監視対象チャンネル ID |
| DISCORD_USER_ID | - | 全員許可 | 操作許可ユーザー ID |
| DEFAULT_CWD | - | `~/Desktop` | メインチャンネルの作業ディレクトリ |
| POLL_INTERVAL_MS | - | `1500` | 出力監視のポーリング間隔（ms） |


## 6. 制約

### 非機能要件

| ID | カテゴリ | 要件 |
|----|----------|------|
| NFR-001 | 応答性 | 出力監視の遅延は POLL_INTERVAL_MS（デフォルト 1500ms）以内 |
| NFR-002 | 並列性 | 複数スレッドのセッションが互いに干渉しない |
| NFR-003 | 前提環境 | tmux がインストール済み、Claude CLI (claude) が PATH に存在（起動時に自動チェック） |
| NFR-004 | Discord 制約 | メッセージは 2000 文字以内に分割して投稿（rate limit 対策付き） |
| NFR-005 | 耐障害性 | セッション死亡検知・通知、unhandledRejection/uncaughtException のキャッチ |
| NFR-006 | 終了処理 | SIGINT/SIGTERM 受信時に全 tmux セッションをクリーンアップして終了 |

### コーディング規約

- TypeScript strict モード
- ESM (ES Modules) 形式
- Bun ランタイムの API を優先使用

### スコープ外

- Bot 再起動時のセッション再接続（kill して再作成で対応）
- セッションライフサイクル管理（タイムアウト・自動終了等は後回し）
- Web UI やダッシュボード
- 認証・認可の高度な仕組み（DISCORD_USER_ID による単純制限は M4 で実装済み）

### 実装前に必要な実機検証

以下の項目は実装着手前に Claude CLI の実機動作を確認し、検出パターンを確定させる。

**必須**

| 項目 | 確認方法 |
|------|----------|
| 入力待ちプロンプトの文字列 | tmux 内で claude 起動 --> capture-pane |
| ツール許可待ちの出力フォーマット | ツールを実行させて capture-pane |
| AskUserQuestion の出力フォーマット | AskUser を使うプロンプトで capture-pane |
| ANSI エスケープの含まれ方 | capture-pane -p の出力を確認 |
| 番号入力で選択肢を選べるか | send-keys "1" Enter で許可できるか |
| 日本語テキストの send-keys | 日本語メッセージを送信できるか |

**確認推奨**

| 項目 | 確認方法 |
|------|----------|
| Claude CLI 起動完了の検知 | 起動直後の capture-pane |
| /clear 後の capture-pane 出力 | /clear 実行後に capture-pane |
| 応答生成中の capture-pane | 生成途中の出力がどう見えるか |
| セッション終了時の出力 | /exit や異常終了時 |
| capture-pane のバッファ上限 | 長い応答で -S -500 が十分か |
