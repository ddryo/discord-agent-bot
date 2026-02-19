/** セッション状態 */
export type SessionState = "idle" | "running";

/** セッション情報（claude -p 方式） */
export interface ClaudeSessionInfo {
  name: string;
  cwd: string;
  threadId: string | null;
  isMain: boolean;
  claudeSessionId: string | null;
  state: SessionState;
  usage: { inputTokens: number; outputTokens: number };
  /** セッション単位の動的許可ツール */
  additionalAllowedTools: Set<string>;
}

/** アプリケーション設定 */
export interface Config {
  discordBotToken: string;
  discordChannelId: string;
  discordUserId?: string;
  defaultCwd: string;
  allowedTools: string[];
}
