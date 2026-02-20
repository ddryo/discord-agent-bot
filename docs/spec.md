# プロジェクト仕様書

## 1. 概要

### 目的

Discord チャンネルから Claude Code CLI を操作する Bot を提供する。`claude -p --output-format stream-json` でプロセスを起動し、stdin/stdout 経由で対話する。Bot 単体で完結する（Claude Code 側の設定不要）。

### コンセプト

- 指定チャンネルへのメッセージ = Claude への送信（コマンド不要）
- スレッド = 独立した Claude セッション（並列動作可）
- `--resume` によるセッション継続で会話コンテキストを維持

### 対象ユーザー

- Claude Code CLI を日常的に利用する開発者
- Discord をコミュニケーション基盤として使用しているチーム・個人


## 2. 機能要件

| ID | 機能名 | 説明 |
|----|--------|------|
| FR-001 | メッセージ送受信 | チャンネルのメッセージを Claude CLI に送信し、応答を Discord に投稿する |
| FR-002 | プロセス管理 | `claude -p --output-format stream-json` でプロセスを起動・制御する |
| FR-003 | stream-json パース | stdout の stream-json イベント（system / assistant / user / result）をパースしてドメインイベントに変換する |
| FR-004 | メインセッション | メインチャンネルに紐づく常駐 Claude セッション（cwd: DEFAULT_CWD） |
| FR-005 | スレッドセッション | スレッド作成時にデフォルト cwd でセッションを起動し、スレッド内メッセージを振り分ける。`/new` コマンドで任意の cwd を指定可能 |
| FR-006 | 複数セッション並列動作 | 複数スレッドの Claude セッションが同時に稼働する |
| FR-007 | ツールブロック通知 | ツール実行がブロックされた際に Embed + ボタン（Approve / Deny）で通知し、Approve 時は `--allowedTools` に追加して自動再送信する |
| FR-008 | AskUserQuestion 通知 | AskUserQuestion を質問 Embed で通知し、次のテキストメッセージで回答 → `--resume` で継続する |
| FR-009 | テキストコマンド | `/clear`, `/status`, `/tools`, `/exit` をテキストコマンドとして処理する |
| FR-010 | スラッシュコマンド | `/clear`, `/status`, `/tools list`, `/tools clear`, `/new` を Application Command として登録・処理する |
| FR-011 | /new コマンド | `title`（必須）と `path`（任意）を引数に取り、チャンネルにスレッドを作成してセッションを起動する |
| FR-012 | セッション起動/終了通知 | セッションの起動・終了時にステータスメッセージを投稿する |
| FR-013 | セッション永続化 | セッション情報を `.data/sessions.json` に保存し、Bot 再起動後に `--resume` で会話を継続する |
| FR-014 | グレースフルシャットダウン | SIGINT/SIGTERM 受信時に全プロセスを終了する |
| FR-015 | 起動時ヘルスチェック | Bot 起動時に Claude CLI の存在を確認する |
| FR-016 | 操作ユーザー制限 | DISCORD_USER_ID が設定されている場合、そのユーザーのみ操作を許可する |
| FR-017 | Discord メッセージ分割 | 2000 文字制限を考慮した分割投稿（コードブロック途中切断の回避） |
| FR-018 | 動的ツール許可 | Approve 時にツールパターンを `--allowedTools` に追加。`/tools list` で確認、`/tools clear` でリセット |
| FR-019 | Typing indicator | Claude 処理中に Discord の「入力中...」表示を維持する |


## 3. 技術スタック

| カテゴリ | 技術 | 選定理由 |
|----------|------|----------|
| ランタイム | Bun | 高速な起動・実行、TypeScript ネイティブサポート |
| 言語 | TypeScript | 型安全性、開発効率 |
| Discord ライブラリ | discord.js | Node.js/Bun 向け Discord API ライブラリのデファクトスタンダード |
| CLI | Claude Code CLI (`claude -p`) | `--output-format stream-json` でプログラマブルな入出力、`--resume` でセッション継続 |


## 4. アーキテクチャ

### ディレクトリ構成

```
discord-agent-bot/
├── src/
│   ├── index.ts              # エントリーポイント・イベントハンドラ接続
│   ├── config.ts             # 環境変数・設定
│   ├── logger.ts             # ログ出力
│   ├── types.ts              # 型定義
│   ├── claude/
│   │   ├── process.ts        # claude -p プロセス起動・stream-json パース
│   │   ├── session.ts        # SessionManager: セッションライフサイクル管理
│   │   └── sessionStore.ts   # セッション情報の永続化（JSON ファイル）
│   └── bot/
│       ├── client.ts         # Discord クライアント初期化・イベント登録
│       ├── commands.ts       # スラッシュコマンド定義・登録
│       ├── handler.ts        # メッセージ受信 → セッション振り分け・コマンド処理
│       ├── responder.ts      # Claude 出力 → Discord 投稿（分割・整形）
│       └── interactions.ts   # ツールブロック・AskUser の通知・ボタン応答処理
├── .data/
│   └── sessions.json         # セッション永続化ファイル（gitignore 対象）
├── docs/
└── .env
```

### プロセスモデル

```
[ユーザーメッセージ]
  │
  ▼
SessionManager.sendMessage(name, text)
  │
  ├── ClaudeProcess を生成
  │     claude -p --output-format stream-json --verbose [--resume sessionId] [--allowedTools ...]
  │
  ├── stdin にプロンプトを書き込み → stdin.end()
  │
  ├── stdout を stream-json としてパース
  │     ├── system   → セッション ID 取得・永続化
  │     ├── assistant → text / tool_use / AskUserQuestion イベント発火
  │     ├── user     → tool_result(is_error) → toolBlocked イベント発火
  │     └── result   → 応答完了
  │
  └── プロセス終了 → exit イベント
        ├── result 受信済み → response イベント（Discord に投稿）
        └── result 未受信 + sessionId 有り → --resume 失敗と判定、ID リセットしてリトライ
```

### コンポーネント構成

```
Discord チャンネル (DISCORD_CHANNEL_ID)
│
├── メッセージ ─────────> SessionManager → ClaudeProcess (cwd: DEFAULT_CWD)
│   └── Claude 応答 <──── stream-json stdout パース
│
├── /new title:"機能A開発" path:~/projects/app
│   └── スレッド「機能A開発」 → SessionManager → ClaudeProcess (cwd: ~/projects/app)
│
├── 手動スレッド「バグ修正」 → SessionManager → ClaudeProcess (cwd: DEFAULT_CWD)
│
└── ...
```

### 通信フロー

```
[Discord メッセージ受信 / スラッシュコマンド受信]
  │
  ▼
[操作ユーザー制限チェック（DISCORD_USER_ID 設定時）]
  │
  ├── 未許可ユーザー → 無視（ボタン応答はエフェメラルで権限なしメッセージ）
  │
  ▼
[スラッシュコマンド判定]
  │
  ├── /new → パスバリデーション → スレッド作成 → セッション登録 → 起動通知
  ├── /clear → sessionId リセット → 区切り Embed
  ├── /status → セッション情報 Embed
  ├── /tools list → 許可ツール一覧 Embed
  ├── /tools clear → 動的許可クリア
  │
  ▼
[テキストコマンド判定（/ で始まるか）]
  │
  ├── /exit → removeSession → 終了通知 Embed
  ├── /clear, /status, /tools → 上記と同等の処理
  ├── 未対応コマンド → エラーメッセージ
  │
  ├── 通常メッセージ
  │   ├── AskUser 待ち → pendingInteraction クリア（回答は sendMessage で --resume 経由）
  │   ├── busy → 「処理中です」返信
  │   └── idle → SessionManager.sendMessage() で Claude プロセス起動
  │
  ▼
[SessionManager イベント]
  │
  ├── response → Discord に投稿（rate limit 対策付き分割送信）
  ├── toolUse → ログ記録のみ
  ├── toolBlocked → 蓄積テキスト配信 + Approve/Deny ボタン付き Embed
  │   ├── Approve → --allowedTools に追加 → autoResendToSession で自動再送信
  │   └── Deny → deny 通知を自動再送信
  ├── askUser → 質問 Embed（テキストメッセージで回答案内）
  ├── error → Discord にエラーメッセージ投稿
  ├── processing → typing indicator 開始
  └── idle → typing indicator 停止

[スレッド作成イベント（threadCreate）]
  │
  ├── /new 経由で既にセッション登録済み → スキップ（二重起動防止）
  └── 手動作成 → DEFAULT_CWD でセッション登録 → 起動通知
```

### stream-json イベント型

Claude CLI の `--output-format stream-json` が出力する NDJSON を `ClaudeProcess` がパースする。

| イベント型 | 説明 | 発火するドメインイベント |
|-----------|------|------------------------|
| `system` | セッション開始。`session_id` を含む | `system`（セッション ID 取得） |
| `assistant` | Claude の応答。`content[]` に text / tool_use ブロック | `text`, `toolUse`, `askUser` |
| `user` | ユーザー側イベント。`tool_result(is_error)` でツールブロックを検出 | `toolBlocked` |
| `result` | 応答完了。`usage` を含む | `result` |

**AskUserQuestion の検出**: `assistant` イベント内の `tool_use` ブロックで `name === "AskUserQuestion"` を検出。`input.questions[]` から質問文と選択肢を抽出する。

**toolBlocked の検出**: `user` イベント内の `tool_result` で `is_error === true` の場合、直前の `tool_use` のツール名・入力と紐づけて `toolBlocked` を発火。ただし `AskUserQuestion` の `tool_result(is_error)` は `-p` モードの正常動作のため抑制する。

### セッション継続モデル

```
[1回目のメッセージ]
  claude -p --output-format stream-json --verbose
  → system イベントから sessionId 取得 → 永続化

[2回目以降のメッセージ]
  claude -p --output-format stream-json --verbose --resume {sessionId}
  → 前回の会話コンテキストを引き継いで応答

[--resume 失敗時]
  → sessionId リセット → 新規セッションとしてリトライ
  → Discord にリセット通知

[Bot 再起動時]
  → .data/sessions.json からセッション情報を復元
  → 次のメッセージで --resume により会話継続
```


## 5. インターフェース

### ClaudeProcess API

`claude -p` プロセスの起動と stream-json パースを担う。

| オプション | 説明 |
|-----------|------|
| `cwd` | プロセスの作業ディレクトリ |
| `sessionId` | `--resume` で指定するセッション ID（省略時は新規セッション） |
| `allowedTools` | `--allowedTools` で指定する許可ツールリスト |

**起動コマンド:**

```
claude -p --output-format stream-json --verbose [--resume {sessionId}] [--allowedTools {tool1}] [--allowedTools {tool2}] ...
```

プロンプトは stdin 経由で送信し、即座に `stdin.end()` する。

### SessionManager API

セッションのライフサイクル管理。プロセスの起動・停止、イベント転送を行う。

| メソッド | 説明 |
|---------|------|
| `registerSession(info)` | セッションを登録する（プロセスは起動しない） |
| `sendMessage(name, text)` | メッセージを送信する。プロセスを起動し応答完了まで待機。--resume 失敗時は自動リトライ |
| `removeSession(name)` | セッションを削除する。実行中プロセスがあれば kill |
| `clearSession(name)` | sessionId をリセットし新しい会話を開始する |
| `addAllowedTool(name, tool)` | セッションに動的ツール許可を追加する |
| `clearAllowedTools(name)` | 動的ツール許可リストをクリアする |
| `restoreSessions()` | 永続化されたセッション情報を復元する（Bot 起動時） |
| `killAll()` | 全セッションのプロセスを終了する（シャットダウン時） |
| `isBusy(name)` | セッションが処理中かを返す |
| `waitForIdle(name)` | セッションが idle になるまで待機する |

**SessionManager イベント:**

| イベント | 引数 | 説明 |
|---------|------|------|
| `response` | sessionName, text, usage | 応答テキストとトークン使用量 |
| `toolUse` | sessionName, toolName, toolInput | ツール実行（ログ用） |
| `toolBlocked` | sessionName, toolName, toolInput, errorContent, bufferedText | ツールがブロックされた |
| `askUser` | sessionName, question, options | AskUserQuestion |
| `error` | sessionName, message | エラー発生 |
| `processing` | sessionName | 処理開始（typing indicator 用） |
| `idle` | sessionName | 処理完了 |

### セッション命名規則

| 種別 | セッション名 | cwd |
|------|-------------|-----|
| メインチャンネル | `main` | DEFAULT_CWD（デフォルト: `~/Desktop`） |
| スレッド（手動作成） | `{threadId}` | DEFAULT_CWD |
| スレッド（`/new` で作成） | `{threadId}` | `/new` の `path` 引数（省略時は DEFAULT_CWD） |

### セッション永続化

`SessionStore` が `.data/sessions.json` にセッション情報を保存する。デバウンス（100ms）付き。

永続化する項目:

| フィールド | 説明 |
|-----------|------|
| `name` | セッション名 |
| `cwd` | 作業ディレクトリ |
| `threadId` | Discord スレッド ID |
| `isMain` | メインセッションかどうか |
| `claudeSessionId` | Claude のセッション ID（--resume 用） |
| `additionalAllowedTools` | 動的許可ツールリスト |

### Discord インタラクション

**ツールブロック通知（FR-007）**

| ボタン | customId | 動作 |
|--------|----------|------|
| Approve | `tool_approve:{sessionName}` | ツールパターンを `--allowedTools` に追加し、前回メッセージを自動再送信 |
| Deny | `tool_deny:{sessionName}` | deny 通知を自動再送信 |

- Embed のタイトル: `Tool Blocked: {ツール名}`、説明にツール入力を JSON コードブロックで表示
- Approve 時のツールパターン生成: Bash の場合はコマンド先頭語で絞る（例: `Bash(mkdir:*)`）、それ以外はツール名そのもの
- 応答後はボタンを disabled に更新し、選択結果と操作ユーザーを表示

**AskUserQuestion（FR-008）**

- Embed のタイトル: `Question`、説明に質問文を表示
- 選択肢がある場合は番号付きリストで表示（ボタンは使わない）
- フッターで「テキストメッセージで回答してください」と案内
- 次のテキストメッセージが `sendMessage` で `--resume` 経由で Claude に送信される

**スレッド作成コマンド（FR-011）**

| 引数 | 必須 | 説明 |
|------|------|------|
| `title` | o | スレッドタイトル（表示用、パスとして解釈しない） |
| `path` | - | セッションの cwd。省略時は DEFAULT_CWD |

処理フロー:
1. `path` が指定されている場合: `BLOCKED_PATHS` チェック + `stat` によるディレクトリ存在確認
2. チャンネルにスレッドを作成（タイトル: `title`）
3. セッションを登録（cwd: 検証済みの `path` または DEFAULT_CWD）
4. 起動通知 Embed をスレッドに投稿
5. `/new` 経由で作成したスレッドは `handleThreadCreate` 側で二重起動しないようガード

**テキストコマンド / スラッシュコマンド**

| コマンド | テキスト | スラッシュ | 処理 |
|----------|---------|-----------|------|
| clear | `/clear` | `/clear` | sessionId リセット + 区切り Embed |
| status | `/status` | `/status` | セッション情報 Embed（名前・状態・cwd・sessionId） |
| tools | `/tools` | `/tools list` | 許可ツール一覧 Embed（静的 + 動的） |
| tools clear | `/tools clear` | `/tools clear` | 動的ツール許可をクリア |
| cost | `/cost` | - | トークン使用量 Embed |
| exit | `/exit` | - | セッション削除 + 終了通知 Embed |
| new | - | `/new` | スレッド + セッション作成 |

**セッション起動/終了通知（FR-012）**

| 通知種別 | Embed 色 | 説明 |
|----------|----------|------|
| 起動 | 緑 (`0x57f287`) | セッション名と作業ディレクトリを表示 |
| 正常終了 | 青 (`0x5865f2`) | 正常終了時 |
| 異常終了 | 赤 (`0xed4245`) | エラー終了時 |
| 手動終了 | 黄 (`0xfee75c`) | `/exit` コマンド実行時 |

**Discord 投稿の rate limit 対策（FR-017）**

| 対策 | 説明 |
|------|------|
| 429 リトライ | Discord API の 429 レスポンス時に `retryAfter` 値を待ってからリトライ（1 回まで） |
| 連続投稿遅延 | 分割投稿時、チャンク間に 500ms の遅延を挿入して rate limit を予防 |

**操作ユーザー制限（FR-016）**

| チェック対象 | 挙動 |
|-------------|------|
| メッセージ（handler.ts） | 未許可ユーザーのメッセージは無視 |
| ボタン応答（interactions.ts） | エフェメラルメッセージで「権限がありません」を表示 |
| スラッシュコマンド（handler.ts） | エフェメラルメッセージで「権限がありません」を表示 |

**エラーハンドリング・安定化（FR-014, FR-015）**

| 機能 | 説明 |
|------|------|
| --resume 失敗検知 | 非ゼロ終了 + sessionId 有り + result 未受信 → sessionId リセットしてリトライ |
| グレースフルシャットダウン | SIGINT/SIGTERM 受信時に `killAll()` → `discord.destroy()` を順次実行。`isShuttingDown` フラグで二重実行を防止 |
| 起動時ヘルスチェック | `claude --version` を実行。未インストール時はエラーメッセージで起動中断 |
| クラッシュ防止 | `process.on('unhandledRejection'/'uncaughtException')` でプロセスクラッシュを防止 |

### 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| DISCORD_BOT_TOKEN | o | - | Discord Bot トークン |
| DISCORD_CHANNEL_ID | o | - | 監視対象チャンネル ID |
| DISCORD_USER_ID | - | 全員許可 | 操作許可ユーザー ID |
| DEFAULT_CWD | - | `~/Desktop` | メインチャンネルの作業ディレクトリ |
| ALLOWED_TOOLS | - | (なし) | 事前許可するツール（カンマ区切り） |


## 6. 制約

### 非機能要件

| ID | カテゴリ | 要件 |
|----|----------|------|
| NFR-001 | 応答性 | stream-json イベント駆動のためポーリング遅延なし |
| NFR-002 | 並列性 | 複数スレッドのセッションが互いに干渉しない |
| NFR-003 | 前提環境 | Claude CLI (`claude`) が PATH に存在（起動時に自動チェック） |
| NFR-004 | Discord 制約 | メッセージは 2000 文字以内に分割して投稿（rate limit 対策付き） |
| NFR-005 | 耐障害性 | --resume 失敗の自動リカバリ、unhandledRejection/uncaughtException のキャッチ |
| NFR-006 | 終了処理 | SIGINT/SIGTERM 受信時に全プロセスを終了してクリーンアップ |
| NFR-007 | 永続性 | セッション情報を JSON ファイルに永続化し、再起動後も会話コンテキストを維持 |

### コーディング規約

- TypeScript strict モード
- ESM (ES Modules) 形式
- Bun ランタイムの API を優先使用
- 非同期関数内では同期 API を使わず `fs.promises.*` や Bun の非同期 API を使用
- `Bun.spawn` の引数配列形式を使用し、シェル文字列結合は禁止（インジェクション対策）

### スコープ外

- Web UI やダッシュボード
- 認証・認可の高度な仕組み（DISCORD_USER_ID による単純制限で対応済み）
- セッションライフサイクル管理（タイムアウト・自動終了等）
