# Discord Claude Bot 設計・実装計画

## 1. プロダクト概要

DiscordチャンネルからClaude Code CLIを操作するBot。
tmux経由でClaude CLIの対話モードを制御し、Bot単体で完結する（Claude Code側の設定不要）。

### コンセプト

- 指定チャンネルへのメッセージ = Claudeへの送信（コマンド不要）
- スレッド = 独立したClaudeセッション（並列動作可）
- tmuxがClaude CLIのプロセス管理・入出力制御を担う

---

## 2. 要件定義

### 2.1 ユーザー操作

| 操作 | 挙動 |
|------|------|
| チャンネルにメッセージ送信 | メインセッション（`~/Desktop`）のClaude CLIに入力される |
| スレッド作成 | スレッドタイトルをcwdパスとして新しいClaudeセッションを起動 |
| スレッド内メッセージ送信 | そのスレッドに紐づくClaudeセッションに入力される |
| `/clear` 等のCLIコマンド送信 | Claude CLIにそのまま送信。`/clear`時はDiscordに区切りを挿入 |

### 2.2 Bot → Discord通知

| イベント | 挙動 |
|----------|------|
| Claudeの応答 | 対応するチャンネル/スレッドに投稿 |
| ツール許可待ち | Approve / Deny ボタン付きEmbed通知 |
| AskUserQuestion | 質問 + 選択肢ボタン通知（テキスト返答も可） |
| セッション起動/終了 | ステータスメッセージ |

### 2.3 セッション管理

- メインチャンネル ↔ 1つの常駐セッション（`~/Desktop`）
- スレッド ↔ 個別セッション（スレッドタイトルのパスがcwd）
- 複数スレッド同時稼働

### 2.4 対応するCLIコマンド

Discord側で `/` 始まりのメッセージを検出し、Claude CLIのスラッシュコマンドとして送信する。

対応コマンド: `/clear`, `/compact`, `/cost`, `/context`, `/status`, `/model`

`/clear` の特別処理: Claude CLI側をクリア後、Discordスレッドにはわかりやすく区切りメッセージを投稿。

### 2.5 前提条件

- ランタイム: Bun
- tmux がインストール済みであること
- Discord Bot トークン取得済み
- Claude CLI (`claude`) がPATHに存在すること

---

## 3. アーキテクチャ

```
Discord チャンネル (DISCORD_CHANNEL_ID)
│
├── メッセージ ──────→ メインtmuxセッション (ccbot-main, cwd: ~/Desktop)
│   └── Claude応答 ←── capture-pane ポーリング
│
├── スレッド「~/projects/app」 ──→ tmuxセッション (ccbot-<threadId>)
│   ├── メッセージ → send-keys
│   └── Claude応答 ←── capture-pane ポーリング
│
├── スレッド「~/work/api」 ──────→ tmuxセッション (ccbot-<threadId>)
└── ...
```

### 通信フロー

```
[Discordメッセージ受信]
  ↓
[セッション特定（なければ作成）]
  ↓
[tmux send-keys でClaude CLIに入力]
  ↓
[capture-pane ポーリングで出力監視]
  ↓ (差分検出)
  ├── 通常テキスト → Discordに投稿
  ├── "Do you want to proceed?" → ボタン付きEmbed通知 → ユーザー応答 → send-keys
  └── AskUserQuestion → 質問+選択肢通知 → ユーザー応答 → send-keys
```

---

## 4. モジュール設計

### ディレクトリ構成

```
src/
├── index.ts              # エントリーポイント
├── config.ts             # 環境変数・設定
├── tmux/
│   ├── manager.ts        # tmuxセッション CRUD・入出力
│   ├── watcher.ts        # capture-pane ポーリング・差分検出
│   └── parser.ts         # ANSI除去・パターン検出
├── bot/
│   ├── client.ts         # Discordクライアント初期化・イベント登録
│   ├── handler.ts        # メッセージ受信 → セッション振り分け
│   ├── responder.ts      # Claude出力 → Discord投稿（分割・整形）
│   └── interactions.ts   # ツール許可・AskUser のボタン通知・応答処理
├── sessions/
│   └── store.ts          # threadId ↔ tmuxセッション の対応管理
├── types.ts              # 型定義
└── logger.ts             # ログ出力
```

### 4.1 tmux/manager.ts — セッション制御

tmuxコマンドをラップし、セッションのライフサイクルを管理する。

```typescript
createSession(name: string, cwd: string): Promise<void>
  // tmux new-session -d -s <name> -c <cwd> "claude"

killSession(name: string): Promise<void>
  // tmux kill-session -t <name>

sendInput(name: string, text: string): Promise<void>
  // tmux send-keys -t <name> -l -- "<text>"
  // tmux send-keys -t <name> Enter

sendKeys(name: string, keys: string): Promise<void>
  // tmux send-keys -t <name> <keys>  (特殊キー用: Escape, Up 等)

capturePane(name: string, lines?: number): Promise<string>
  // tmux capture-pane -p -t <name> -S -<lines>

hasSession(name: string): Promise<boolean>
  // tmux has-session -t <name>

listSessions(): Promise<string[]>
  // tmux list-sessions -F "#{session_name}" | grep "^ccbot-"
```

### 4.2 tmux/watcher.ts — 出力監視

セッションごとに定期的に `capturePane` を呼び、前回との差分を検出。
検出した差分の種別（通常テキスト / 許可待ち / AskUser / アイドル）に応じてイベントを発火する。

```typescript
class OutputWatcher extends EventEmitter {
  // イベント: "output", "tool-approval", "ask-user", "idle", "session-end"

  watch(sessionName: string): void    // ポーリング開始
  unwatch(sessionName: string): void  // ポーリング停止
}
```

ポーリング間隔: デフォルト1500ms（環境変数で調整可）

### 4.3 tmux/parser.ts — 出力解析

```typescript
stripAnsi(text: string): string
  // ANSIエスケープシーケンス除去

detectToolApproval(output: string): ToolApprovalInfo | null
  // "Do you want to proceed?" パターン検出

detectAskUser(output: string): AskUserInfo | null
  // AskUserQuestion パターン検出

detectIdlePrompt(output: string): boolean
  // Claude CLIの入力待ちプロンプト検出

detectSessionEnd(output: string): boolean
  // セッション終了検出
```

### 4.4 bot/client.ts — Discord初期化

```typescript
// Intents: Guilds, GuildMessages, MessageContent
// イベント登録: messageCreate, interactionCreate, threadCreate
```

### 4.5 bot/handler.ts — メッセージ振り分け

```typescript
onMessage(message: Message):
  1. 対象チャンネル(DISCORD_CHANNEL_ID)か確認
  2. Bot自身のメッセージは無視
  3. 操作許可ユーザー(DISCORD_USER_ID)か確認
  4. スレッド内 → threadIdでセッション特定
     メインチャンネル → メインセッション
  5. セッションが未起動なら作成
  6. CLIコマンド（/clear等）ならコマンド処理
  7. 通常メッセージなら send-keys で入力

onThreadCreate(thread: ThreadChannel):
  1. 対象チャンネルの子スレッドか確認
  2. スレッドタイトルをパスとして解釈（チルダ展開）
  3. パス存在チェック → 失敗なら通知して終了
  4. 新規tmuxセッション作成
  5. 起動完了通知
```

### 4.6 bot/responder.ts — Discord投稿

```typescript
class Responder {
  postOutput(target: TextChannel | ThreadChannel, text: string): Promise<void>
    // Discordの2000文字制限で分割投稿
    // Markdown整形
    // コードブロックが途中で切れないよう考慮
}
```

### 4.7 bot/interactions.ts — ツール許可・AskUser

```typescript
// ツール許可待ち
sendToolApproval(target, info: ToolApprovalInfo): Promise<void>
  // Embed + Approve/Deny/AlwaysAllow ボタン送信

onToolApprovalResponse(interaction, sessionName): Promise<void>
  // Approve → send-keys で選択肢1を入力
  // Deny   → send-keys で選択肢3を入力
  // AlwaysAllow → send-keys で選択肢2を入力

// AskUserQuestion
sendAskUser(target, info: AskUserInfo): Promise<void>
  // 質問 + 選択肢ボタン送信

onAskUserResponse(interaction | message, sessionName): Promise<void>
  // 選択肢番号 or テキストを send-keys で送信
```

### 4.8 sessions/store.ts — セッション状態管理

```typescript
class SessionStore {
  // メインセッション
  mainSession: TmuxSessionInfo | null

  // スレッドID → セッション情報
  threadSessions: Map<string, TmuxSessionInfo>

  getSession(threadId: string | null): TmuxSessionInfo | null
  registerSession(threadId: string | null, info: TmuxSessionInfo): void
  removeSession(threadId: string | null): void
  getAllSessions(): TmuxSessionInfo[]
}
```

---

## 5. 環境変数

```env
DISCORD_BOT_TOKEN=        # Discord Bot トークン（必須）
DISCORD_CHANNEL_ID=       # 監視対象チャンネルID（必須）
DISCORD_USER_ID=          # 操作許可ユーザーID（任意、未指定なら全員許可）
DEFAULT_CWD=~/Desktop     # メインチャンネルの作業ディレクトリ
POLL_INTERVAL_MS=1500     # capture-pane ポーリング間隔（ms）
```

---

## 6. 実装ステップ

### Phase 1: 最小動作（メッセージ送受信）

1. プロジェクト初期化（Bun + TypeScript + discord.js）
2. `config.ts` — 環境変数読み込み
3. `logger.ts` — ログ出力
4. `tmux/manager.ts` — セッション作成・破棄・send-keys・capture-pane
5. `bot/client.ts` — Discordクライアント起動
6. `bot/handler.ts` — チャンネルメッセージ → send-keys
7. `tmux/parser.ts` — ANSI除去
8. `tmux/watcher.ts` — ポーリング・差分検出（通常出力のみ）
9. `bot/responder.ts` — 差分をDiscordに投稿
10. `sessions/store.ts` — メインセッション管理

**ゴール**: チャンネルにメッセージを送ると、Claudeの応答がDiscordに返ってくる

### Phase 2: マルチセッション（スレッド対応）

11. スレッド作成 → 新規tmuxセッション起動
12. スレッド内メッセージ → 対応セッションに振り分け
13. 複数セッションの並列ポーリング

**ゴール**: スレッドごとに独立したClaudeセッションが動く

### Phase 3: インタラクション（通知・応答）

14. `tmux/parser.ts` にツール許可・AskUser検出パターン追加
15. `bot/interactions.ts` — ボタン付き通知・応答処理
16. CLIコマンド対応（`/clear` → 区切り挿入、`/compact`等）

**ゴール**: ツール許可・AskUserの通知と応答がDiscord上で完結する

### Phase 4: 安定化

17. エラーハンドリング（セッション死亡検知・通知）
18. グレースフルシャットダウン（SIGINT/SIGTERM → 全セッション終了）
19. Bot起動時のtmux存在チェック・Claude CLI存在チェック
20. 長時間出力・大量出力への対策

---

## 7. 実装前に必要な調査（実機確認）

以下の項目は実装着手前にClaude CLIの実機動作を確認して、検出パターンを確定させる必要がある。

### 必須

| 項目 | 確認方法 |
|------|----------|
| 入力待ちプロンプトの文字列 | tmux内でclaude起動 → capture-pane |
| ツール許可待ちの出力フォーマット | ツールを実行させて capture-pane |
| AskUserQuestionの出力フォーマット | AskUserを使うプロンプトで capture-pane |
| ANSIエスケープの含まれ方 | capture-pane -p の出力を確認 |
| 番号入力で選択肢を選べるか | send-keys "1" Enter で許可できるか |
| 日本語テキストの send-keys | 日本語メッセージを送信できるか |

### 確認推奨

| 項目 | 確認方法 |
|------|----------|
| Claude CLI起動完了の検知 | 起動直後の capture-pane |
| `/clear` 後の capture-pane 出力 | /clear実行後に capture-pane |
| 応答生成中の capture-pane | 生成途中の出力がどう見えるか |
| セッション終了時の出力 | `/exit` や異常終了時 |
| capture-pane のバッファ上限 | 長い応答で `-S -200` が十分か |

---

## 8. リスクと対策

| リスク | 対策 |
|--------|------|
| Claude CLIの出力フォーマット変更 | 検出パターンを正規表現で柔軟に定義、パーサーを分離して変更容易に |
| ポーリングの応答遅延 | 間隔を環境変数で調整可能に |
| capture-paneのバッファ不足 | スクロールバック行数を十分確保（`-S -500` 等） |
| 複数セッションのリソース消費 | 最大セッション数に上限を設ける |
| tmux未インストール | 起動時チェックでエラーメッセージ表示 |
