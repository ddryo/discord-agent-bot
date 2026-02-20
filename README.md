# discord-agent-bot

Discord チャンネルから Claude Code CLI を操作する Bot。
メッセージを送るだけで Claude と対話でき、スレッドごとに独立したセッションを並列で動かせます。

## 前提条件

- [Bun](https://bun.sh/) v1.0+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) がインストール済みで PATH に通っていること
- Discord Bot トークンを取得済みであること

## セットアップ

### 1. Discord Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) で新しいアプリケーションを作成
2. Bot セクションで Bot を追加し、トークンをコピー
3. 以下の Privileged Gateway Intents を有効化:
   - **Message Content Intent**
4. OAuth2 > URL Generator で以下の権限を付与して招待 URL を生成:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Create Public Threads`, `Send Messages in Threads`, `Manage Messages`, `Read Message History`, `Use Slash Commands`
5. 生成された URL でサーバーに Bot を招待

### 2. インストール

```bash
git clone https://github.com/your-username/discord-agent-bot.git
cd discord-agent-bot
bun install
```

### 3. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集して必要な値を設定:

```env
# 必須
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_CHANNEL_ID=your-channel-id

# オプション
DISCORD_USER_ID=your-discord-user-id    # 操作を許可するユーザー（未設定で全員許可）
DEFAULT_CWD=~/Desktop                    # Claude の作業ディレクトリ
ALLOWED_TOOLS=Bash(ls:*),Read,Glob       # 事前許可するツール（カンマ区切り）
```

`DISCORD_CHANNEL_ID` は Bot が監視するチャンネルの ID です。Discord の開発者モードを有効にしてチャンネルを右クリック → 「IDをコピー」で取得できます。

### 4. 起動

```bash
bun start
```

## 使い方

### 基本操作

指定チャンネルにメッセージを送ると、そのまま Claude に送信されます。コマンドやプレフィックスは不要です。

```
このプロジェクトのディレクトリ構成を教えて
```

Claude の応答は同じチャンネルに投稿されます。会話コンテキストは維持されるので、続けて質問できます。

### スレッド = 独立セッション

スレッドを作成すると、独立した Claude セッションが自動で立ち上がります。メインチャンネルとスレッド、スレッド同士は互いに干渉しません。

**`/new` コマンドで作成（推奨）:**

```
/new title:バグ修正 path:~/projects/my-app
```

- `title` (必須): スレッドのタイトル
- `path` (任意): そのセッションの作業ディレクトリ。省略時は `DEFAULT_CWD`

手動でスレッドを作成した場合も自動的にセッションが起動します（cwd は `DEFAULT_CWD`）。

### ツール許可

Claude がツールを使おうとしてブロックされると、Approve / Deny ボタン付きの通知が表示されます。

- **Approve**: そのツールを許可し、処理を自動的に再開します。以降の同セッション内では同じツールが自動許可されます。
- **Deny**: ツールの実行を拒否し、Claude にその旨を伝えます。

### コマンド一覧

テキストコマンド（チャンネル/スレッドに直接入力）:

| コマンド | 説明 |
|----------|------|
| `/clear` | セッションの会話コンテキストをリセット |
| `/status` | セッションの状態を表示 |
| `/tools` | 許可されたツール一覧を表示 |
| `/tools clear` | セッションの動的ツール許可をクリア |
| `/exit` | セッションを終了 |

スラッシュコマンド（Discord の入力欄から選択）:

| コマンド | 説明 |
|----------|------|
| `/clear` | セッションの会話コンテキストをリセット |
| `/status` | セッションの状態を表示 |
| `/tools list` | 許可されたツール一覧を表示 |
| `/tools clear` | セッションの動的ツール許可をクリア |
| `/new` | 新しいスレッドとセッションを作成 |

### セッションの永続化

セッション情報は自動的に保存されます。Bot を再起動しても、前回の会話コンテキストを引き継いで対話を続けられます。

## ライセンス

MIT
