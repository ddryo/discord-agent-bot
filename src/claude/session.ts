import { EventEmitter } from "events";
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import type { ClaudeSessionInfo } from "../types.ts";
import { ClaudeProcess } from "./process.ts";

const logger = createLogger("claude:session");

interface SessionEntry {
  info: ClaudeSessionInfo;
  process: ClaudeProcess | null;
  textBuffer: string;
}

export interface SessionManagerEvents {
  response: [sessionName: string, text: string, usage: { inputTokens: number; outputTokens: number }];
  toolUse: [sessionName: string, toolName: string, toolInput: Record<string, unknown>];
  toolBlocked: [sessionName: string, toolName: string, toolInput: Record<string, unknown>, errorContent: string, bufferedText: string];
  askUser: [sessionName: string, question: string, options: string[]];
  error: [sessionName: string, message: string];
  idle: [sessionName: string];
}

/**
 * セッションライフサイクル管理。
 * プロセスの起動・停止、イベント転送を行う。
 */
export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private sessions = new Map<string, SessionEntry>();

  /**
   * セッションを登録する（プロセスは起動しない）。
   */
  registerSession(info: ClaudeSessionInfo): void {
    if (this.sessions.has(info.name)) {
      logger.warn(`Session already registered: ${info.name}`);
      return;
    }
    this.sessions.set(info.name, { info, process: null, textBuffer: "" });
    logger.info(`Session registered: ${info.name} (cwd: ${info.cwd})`);
  }

  /**
   * セッションにメッセージを送信する。
   * プロセスを起動し、応答完了まで待機する。
   * --resume 失敗時はセッションIDをリセットして自動リトライする。
   */
  async sendMessage(name: string, text: string): Promise<void> {
    const entry = this.sessions.get(name);
    if (!entry) {
      throw new Error(`Session not found: ${name}`);
    }

    if (entry.info.state === "running") {
      throw new Error(`Session is busy: ${name}`);
    }

    const hadSessionId = !!entry.info.claudeSessionId;
    const result = await this.runProcess(entry, text);

    // --resume 失敗検知: 非ゼロ終了 + セッションID有り + result未受信 → リトライ
    if (!result.resultReceived && result.exitCode !== 0 && hadSessionId) {
      logger.warn(
        `Session resume failed (exit code ${result.exitCode}), resetting session ID and retrying: ${name}`,
      );
      entry.info.claudeSessionId = null;
      this.emit(
        "error",
        name,
        "セッションの再開に失敗したため、新しいセッションで再試行します。（以前の会話コンテキストはリセットされています）",
      );
      await this.runProcess(entry, text, true);
    }
  }

  /**
   * claude -p プロセスを1回実行する。
   * isRetry=false の場合、resume 失敗の可能性があるため error イベントを抑制する。
   */
  private runProcess(
    entry: SessionEntry,
    text: string,
    isRetry = false,
  ): Promise<{ resultReceived: boolean; exitCode: number }> {
    const name = entry.info.name;
    entry.info.state = "running";
    entry.textBuffer = "";
    const isResuming = !!entry.info.claudeSessionId;

    const allowedTools = [
      ...config.allowedTools,
      ...entry.info.additionalAllowedTools,
    ];

    const proc = new ClaudeProcess({
      cwd: entry.info.cwd,
      sessionId: entry.info.claudeSessionId ?? undefined,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
    });

    entry.process = proc;

    return new Promise((resolve) => {
      let resultReceived = false;
      let resultUsage = { inputTokens: 0, outputTokens: 0 };

      proc.on("system", (sessionId) => {
        if (!isResuming) {
          // 新規セッション: system イベントからセッションIDを取得
          entry.info.claudeSessionId = sessionId;
          logger.info(`Session ID acquired: ${name} → ${sessionId}`);
        } else {
          // resume 時: system イベントのIDが実際のセッションIDと異なる場合があるため無視
          logger.debug(
            `Ignoring system session_id during resume: ${sessionId} (keeping ${entry.info.claudeSessionId})`,
          );
        }
      });

      proc.on("text", (chunk) => {
        entry.textBuffer += chunk;
      });

      proc.on("toolUse", (toolName, toolInput, _id) => {
        this.emit("toolUse", name, toolName, toolInput);
      });

      proc.on("toolBlocked", (toolName, toolInput, errorContent) => {
        // 蓄積テキストを toolBlocked イベントに含めて渡す（index.ts 側で先に配信）
        const bufferedText = entry.textBuffer;
        entry.textBuffer = "";
        this.emit("toolBlocked", name, toolName, toolInput, errorContent, bufferedText);
      });

      proc.on("askUser", (question, options, _toolUseId) => {
        this.emit("askUser", name, question, options);
      });

      proc.on("result", (_fullText, usage) => {
        resultReceived = true;
        resultUsage = usage;
        // resolve は exit イベントで行う（exit code を確認するため）
      });

      proc.on("error", (message) => {
        this.emit("error", name, message);
      });

      proc.on("exit", (exitCode) => {
        entry.info.state = "idle";
        entry.process = null;

        const hasContent = resultReceived && entry.textBuffer.trim() !== "";

        if (hasContent) {
          // テキストが存在する場合はレスポンスを配信
          entry.info.usage.inputTokens += resultUsage.inputTokens;
          entry.info.usage.outputTokens += resultUsage.outputTokens;
          this.emit("response", name, entry.textBuffer, resultUsage);
        }

        if (exitCode !== 0 && hasContent) {
          // レスポンス配信済みだがプロセスが異常終了
          this.emit("error", name, `Process exited with code ${exitCode}`);
        } else if (exitCode !== 0 && !hasContent && isRetry) {
          // リトライ後もコンテンツなしで失敗
          this.emit("error", name, `Process exited with code ${exitCode}`);
        }
        // exitCode !== 0 && !hasContent && !isRetry → sendMessage 側でリトライ判定

        this.emit("idle", name);
        resolve({ resultReceived: hasContent, exitCode });
      });

      proc.run(text);
    });
  }

  /**
   * セッションを削除する。実行中プロセスがあれば kill する。
   */
  removeSession(name: string): void {
    const entry = this.sessions.get(name);
    if (!entry) return;

    if (entry.process) {
      entry.process.kill();
    }
    this.sessions.delete(name);
    logger.info(`Session removed: ${name}`);
  }

  /**
   * セッションをクリアする（sessionId をリセットし、新しい会話を開始）。
   */
  clearSession(name: string): void {
    const entry = this.sessions.get(name);
    if (!entry) return;

    entry.info.claudeSessionId = null;
    entry.info.additionalAllowedTools.clear();
    logger.info(`Session cleared: ${name}`);
  }

  /**
   * セッションのトークン使用量を取得する。
   */
  getUsage(name: string): { inputTokens: number; outputTokens: number } | null {
    const entry = this.sessions.get(name);
    if (!entry) return null;
    return { ...entry.info.usage };
  }

  /**
   * セッションが処理中かどうかを返す。
   */
  isBusy(name: string): boolean {
    const entry = this.sessions.get(name);
    if (!entry) return false;
    return entry.info.state === "running";
  }

  /**
   * セッションが idle になるまで待機する。
   * 既に idle の場合は即座に resolve する。
   */
  waitForIdle(name: string, timeoutMs = 30000): Promise<void> {
    if (!this.isBusy(name)) return Promise.resolve();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("idle", onIdle);
        logger.warn(`waitForIdle timed out for session: ${name}`);
        resolve();
      }, timeoutMs);

      const onIdle = (sessionName: string) => {
        if (sessionName === name) {
          clearTimeout(timer);
          this.off("idle", onIdle);
          resolve();
        }
      };

      this.on("idle", onIdle);
    });
  }

  /**
   * セッション情報を取得する。
   */
  getSession(name: string): ClaudeSessionInfo | undefined {
    return this.sessions.get(name)?.info;
  }

  /**
   * threadId からセッションを検索する。
   */
  getSessionByThreadId(threadId: string): ClaudeSessionInfo | undefined {
    for (const entry of this.sessions.values()) {
      if (entry.info.threadId === threadId) {
        return entry.info;
      }
    }
    return undefined;
  }

  /**
   * セッションが存在するかどうかを返す。
   */
  hasSession(name: string): boolean {
    return this.sessions.has(name);
  }

  /**
   * セッション名で SessionEntry を検索する（内部ヘルパー）。
   */
  getSessionByName(name: string): ClaudeSessionInfo | undefined {
    return this.sessions.get(name)?.info;
  }

  /**
   * セッションに動的ツール許可を追加する。
   */
  addAllowedTool(name: string, tool: string): void {
    const entry = this.sessions.get(name);
    if (!entry) return;
    entry.info.additionalAllowedTools.add(tool);
    logger.info(`Allowed tool added: ${name} → ${tool}`);
  }

  /**
   * セッションの動的ツール許可リストを取得する。
   */
  getAllowedTools(name: string): string[] {
    const entry = this.sessions.get(name);
    if (!entry) return [];
    return [...entry.info.additionalAllowedTools];
  }

  /**
   * セッションの動的ツール許可リストをクリアする。
   */
  clearAllowedTools(name: string): void {
    const entry = this.sessions.get(name);
    if (!entry) return;
    entry.info.additionalAllowedTools.clear();
    logger.info(`Allowed tools cleared: ${name}`);
  }

  /**
   * 全セッションのプロセスを終了する。
   */
  killAll(): void {
    for (const [name, entry] of this.sessions) {
      if (entry.process) {
        entry.process.kill();
        logger.info(`Killed process for session: ${name}`);
      }
    }
    this.sessions.clear();
  }

  /**
   * claude CLI の存在を確認する。
   */
  static async checkDependencies(): Promise<string> {
    try {
      const proc = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error(`claude --version failed (exit ${exitCode}): ${stderr.trim()}`);
      }
      return stdout.trim();
    } catch (error) {
      throw new Error(`Claude CLI (claude) が見つからないか正常に動作しません: ${String(error)}`);
    }
  }
}
