import type { TmuxSessionInfo } from "../types.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("sessions:store");

export class SessionStore {
  private sessions = new Map<string | null, TmuxSessionInfo>();

  getSession(threadId: string | null): TmuxSessionInfo | undefined {
    return this.sessions.get(threadId);
  }

  registerSession(threadId: string | null, info: TmuxSessionInfo): void {
    this.sessions.set(threadId, info);
    logger.info(
      `Session registered: ${info.name} (threadId: ${threadId ?? "main"})`,
    );
  }

  removeSession(threadId: string | null): void {
    const info = this.sessions.get(threadId);
    if (info) {
      this.sessions.delete(threadId);
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
