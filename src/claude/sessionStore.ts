import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { createLogger } from "../logger.ts";

const logger = createLogger("claude:sessionStore");

/** 永続化するセッション情報 */
export interface PersistedSession {
  name: string;
  cwd: string;
  threadId: string | null;
  isMain: boolean;
  claudeSessionId: string | null;
  additionalAllowedTools: string[];
}

const DATA_DIR = join(import.meta.dir, "../../.data");
const STORE_PATH = join(DATA_DIR, "sessions.json");

/**
 * セッション情報の永続化を管理する。
 * JSON ファイルへの保存・読み込みを行う。
 */
export class SessionStore {
  private dirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 保存済みセッション情報を読み込む。
   * ファイルが存在しない場合は空配列を返す。
   */
  async load(): Promise<PersistedSession[]> {
    try {
      const raw = await readFile(STORE_PATH, "utf-8");
      const data = JSON.parse(raw) as PersistedSession[];
      logger.info(`Loaded ${data.length} sessions from store`);
      return data;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.debug("Session store file not found, starting fresh");
        return [];
      }
      logger.error(`Failed to load session store: ${String(error)}`);
      return [];
    }
  }

  /**
   * セッション情報をファイルに保存する。
   * 短時間に複数回呼ばれた場合はデバウンスする。
   */
  async save(sessions: PersistedSession[]): Promise<void> {
    this.dirty = true;

    // デバウンス: 100ms 以内の連続書き込みをまとめる
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }

    this.writeTimer = setTimeout(() => {
      void this.flush(sessions);
    }, 100);
  }

  /**
   * 即時書き込みを行う。
   */
  private async flush(sessions: PersistedSession[]): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;

    try {
      await mkdir(dirname(STORE_PATH), { recursive: true });
      await writeFile(STORE_PATH, JSON.stringify(sessions, null, 2), "utf-8");
      logger.debug(`Saved ${sessions.length} sessions to store`);
    } catch (error) {
      logger.error(`Failed to save session store: ${String(error)}`);
    }
  }
}
