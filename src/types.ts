/**
 * 出力イベントの種別
 */
export type OutputEventType =
  | "text"
  | "tool_approval"
  | "ask_user"
  | "idle"
  | "session_end"
  | "error";

/**
 * ツール実行許可情報（M3 で使用）
 */
export interface ToolApprovalInfo {
  tool: string;
  description?: string;
  options: string[];
}

/**
 * AskUser 情報（M3 で使用）
 */
export interface AskUserInfo {
  question: string;
  options?: string[];
}

/**
 * パーサーが生成する出力イベント
 */
export interface OutputEvent {
  type: OutputEventType;
  content: string;
  raw?: string;
  timestamp: Date;
  metadata?: ToolApprovalInfo | AskUserInfo;
}

/**
 * tmux セッション情報
 */
export interface TmuxSessionInfo {
  name: string;
  cwd: string;
  threadId: string | null;
  isMain: boolean;
}

/**
 * セッションの状態
 */
export type SessionState = "starting" | "ready" | "busy" | "dead";

/**
 * アプリケーション設定
 */
export interface Config {
  discordBotToken: string;
  discordChannelId: string;
  discordUserId?: string;
  defaultCwd: string;
  pollIntervalMs: number;
}
