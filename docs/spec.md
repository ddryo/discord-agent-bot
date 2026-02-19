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
| FR-003 | 出力監視 | tmux の出力をポーリングまたは pipe-pane で監視し、差分を検出する | Must | o |
| FR-004 | 出力パース | raw テキストを正規化イベント（text / tool_approval / ask_user / idle / session_end / error）に変換する | Must | o |
| FR-005 | メインセッション | メインチャンネルに紐づく常駐 Claude セッション（cwd: DEFAULT_CWD） | Must | o |
| FR-006 | スレッドセッション | スレッド作成時にスレッドタイトルを cwd としたセッションを起動し、スレッド内メッセージを振り分ける | Must | o |
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
│   ├── index.ts              # エントリーポイント
│   ├── config.ts             # 環境変数・設定
│   ├── logger.ts             # ログ出力
│   ├── types.ts              # 型定義
│   ├── tmux/
│   │   ├── manager.ts        # tmux セッション CRUD・入出力
│   │   ├── watcher.ts        # 出力監視（ポーリング or pipe-pane）・差分検出
│   │   └── parser.ts         # ANSI 除去・パターン検出・イベント変換
│   ├── bot/
│   │   ├── client.ts         # Discord クライアント初期化・イベント登録
│   │   ├── handler.ts        # メッセージ受信 → セッション振り分け
│   │   ├── responder.ts      # Claude 出力 → Discord 投稿（分割・整形）
│   │   └── interactions.ts   # ツール許可・AskUser のボタン通知・応答処理
│   └── sessions/
│       └── store.ts          # threadId <-> tmux セッションの対応管理
├── docs/
├── tests/
└── .env
```

### コンポーネント構成

```
Discord チャンネル (DISCORD_CHANNEL_ID)
|
+-- メッセージ ----------> メイン tmux セッション (ccbot-main, cwd: DEFAULT_CWD)
|   +-- Claude 応答 <---- 出力監視 (capture-pane / pipe-pane)
|
+-- スレッド「~/projects/app」 --> tmux セッション (ccbot-<threadId>)
|   +-- メッセージ --> send-keys
|   +-- Claude 応答 <---- 出力監視
|
+-- スレッド「~/work/api」 ------> tmux セッション (ccbot-<threadId>)
+-- ...
```

### 通信フロー

```
[Discord メッセージ受信]
  |
  v
[セッション特定（なければ作成）]
  |
  v
[tmux send-keys で Claude CLI に入力]
  |
  v
[出力監視で差分検出]
  |
  +-- 通常テキスト --> Discord に投稿
  +-- ツール許可待ち --> ボタン付き Embed --> ユーザー応答 --> send-keys
  +-- AskUserQuestion --> 質問 + ボタン --> ユーザー応答 --> send-keys
  +-- アイドル --> 待機
  +-- セッション終了 --> 通知
  +-- エラー --> エラー通知
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

### 出力監視方式の検討事項

以下の 2 方式を実装フェーズで検証し、採用を決定する。

| 方式 | 仕組み | メリット | デメリット |
|------|--------|----------|------------|
| capture-pane ポーリング | 定期的に `tmux capture-pane -p` を実行し差分比較 | 実装がシンプル | ポーリング間隔分の遅延、差分検出の複雑さ |
| pipe-pane + fs.watch | `tmux pipe-pane` でファイルにストリーム出力し `fs.watch` で監視 | イベント駆動で低遅延 | 実機検証が未済、ファイル管理が必要 |


## 5. インターフェース

### tmux セッション管理 API

| 操作 | tmux コマンド | 説明 |
|------|--------------|------|
| セッション作成 | `tmux new-session -d -s {name} -c {cwd} "claude"` | Claude CLI を起動するセッションを作成 |
| セッション破棄 | `tmux kill-session -t {name}` | セッションを終了 |
| テキスト入力 | `tmux send-keys -t {name} -l -- "{text}"` + `send-keys Enter` | Claude CLI にテキストを送信 |
| 特殊キー送信 | `tmux send-keys -t {name} {keys}` | Escape, Up 等の特殊キー |
| 画面キャプチャ | `tmux capture-pane -p -t {name} -S -{lines}` | 出力テキストを取得 |
| セッション確認 | `tmux has-session -t {name}` | セッションの存在確認 |
| セッション一覧 | `tmux list-sessions -F "#{session_name}"` | ccbot- プレフィックスでフィルタ |

### セッション命名規則

| 種別 | セッション名 | cwd |
|------|-------------|-----|
| メインチャンネル | `ccbot-main` | DEFAULT_CWD（デフォルト: `~/Desktop`） |
| スレッド | `ccbot-{threadId}` | スレッドタイトルのパス |

### Discord インタラクション

**ツール許可待ち（FR-008）**

| ボタン | アクション |
|--------|-----------|
| Approve | 選択肢 1 を send-keys で送信 |
| Always Allow | 選択肢 2 を send-keys で送信 |
| Deny | 選択肢 3 を send-keys で送信 |

**AskUserQuestion（FR-009）**

- 選択肢がある場合: ボタンで選択
- テキスト返答: Discord メッセージで入力 --> send-keys で送信

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
| NFR-003 | 前提環境 | tmux がインストール済み、Claude CLI (claude) が PATH に存在 |
| NFR-004 | Discord 制約 | メッセージは 2000 文字以内に分割して投稿 |

### コーディング規約

- TypeScript strict モード
- ESM (ES Modules) 形式
- Bun ランタイムの API を優先使用

### スコープ外（MVP で割り切る点）

- Bot 再起動時のセッション再接続（kill して再作成で対応）
- Discord rate limit キュー（問題が出てから対応）
- セッションライフサイクル管理（タイムアウト・自動終了等は後回し）
- Web UI やダッシュボード
- 認証・認可の高度な仕組み（DISCORD_USER_ID による単純制限のみ）

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
| capture-pane のバッファ上限 | 長い応答で -S -200 が十分か |
