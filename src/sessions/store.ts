import type { TmuxSessionInfo } from "../types.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("sessions:store");

/** メインセッション用の内部キー（Map に null を使わないための定数） */
const MAIN_KEY = "__main__";

export class SessionStore {
  private sessions = new Map<string, TmuxSessionInfo>();

  private toKey(threadId: string | null): string {
    return threadId ?? MAIN_KEY;
  }

  getSession(threadId: string | null): TmuxSessionInfo | undefined {
    return this.sessions.get(this.toKey(threadId));
  }

  registerSession(threadId: string | null, info: TmuxSessionInfo): void {
    const key = this.toKey(threadId);
    this.sessions.set(key, info);
    logger.info(
      `Session registered: ${info.name} (threadId: ${threadId ?? "main"})`,
    );
  }

  removeSession(threadId: string | null): void {
    const key = this.toKey(threadId);
    const info = this.sessions.get(key);
    if (info) {
      this.sessions.delete(key);
      logger.info(
        `Session removed: ${info.name} (threadId: ${threadId ?? "main"})`,
      );
    }
  }

  getSessionByName(sessionName: string): TmuxSessionInfo | undefined {
    for (const info of this.sessions.values()) {
      if (info.name === sessionName) {
        return info;
      }
    }
    return undefined;
  }

  getAllSessions(): TmuxSessionInfo[] {
    return [...this.sessions.values()];
  }
}

export const sessionStore = new SessionStore();
