import { EventEmitter } from "events";
import { capturePane } from "./manager.ts";
import { parseOutput } from "./parser.ts";
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import type { OutputEvent } from "../types.ts";

const logger = createLogger("watcher");

interface WatcherEntry {
  timer: ReturnType<typeof setInterval>;
  lastContent: string;
}

export interface OutputWatcherEvents {
  output: [sessionName: string, events: OutputEvent[]];
}

/**
 * tmux セッションの出力を定期的にポーリングし、
 * 差分を検出してイベントとして発火する。
 */
export class OutputWatcher extends EventEmitter<OutputWatcherEvents> {
  private sessions = new Map<string, WatcherEntry>();

  /**
   * 指定セッションの出力監視を開始する。
   * pollIntervalMs ごとに capturePane を実行し、差分を検出する。
   */
  watch(sessionName: string): void {
    if (this.sessions.has(sessionName)) {
      logger.warn(`Already watching session: ${sessionName}`);
      return;
    }

    logger.info(`Start watching session: ${sessionName}`);

    const entry: WatcherEntry = {
      timer: setInterval(() => {
        void this.poll(sessionName);
      }, config.pollIntervalMs),
      lastContent: "",
    };

    this.sessions.set(sessionName, entry);
  }

  /**
   * 指定セッションの出力監視を停止する。
   */
  unwatch(sessionName: string): void {
    const entry = this.sessions.get(sessionName);
    if (!entry) {
      return;
    }

    logger.info(`Stop watching session: ${sessionName}`);
    clearInterval(entry.timer);
    this.sessions.delete(sessionName);
  }

  /**
   * 全セッションの監視を停止する。
   */
  unwatchAll(): void {
    for (const [sessionName] of this.sessions) {
      this.unwatch(sessionName);
    }
  }

  /**
   * 1 回のポーリング処理。
   * capturePane で現在の出力を取得し、前回との差分を抽出する。
   */
  private async poll(sessionName: string): Promise<void> {
    const entry = this.sessions.get(sessionName);
    if (!entry) {
      return;
    }

    try {
      const currentContent = await capturePane(sessionName);
      const diff = this.extractDiff(entry.lastContent, currentContent);
      entry.lastContent = currentContent;

      if (!diff) {
        return;
      }

      const events = parseOutput(diff);
      if (events.length > 0) {
        this.emit("output", sessionName, events);
      }
    } catch (error) {
      logger.error(`Poll error for session ${sessionName}: ${error}`);
    }
  }

  /**
   * 前回のキャプチャ結果と今回の結果を比較し、新しく追加された部分を返す。
   *
   * capture-pane はスクロールバッファ全体を返すため、
   * 前回の末尾部分を今回の出力内で探し、それ以降を差分とする。
   */
  private extractDiff(previous: string, current: string): string {
    if (!previous) {
      return current;
    }

    if (previous === current) {
      return "";
    }

    // 前回の末尾行群を使って、今回の出力内で一致する位置を探す
    const prevLines = previous.trimEnd().split("\n");
    const currentLines = current.trimEnd().split("\n");

    // 前回の末尾から一定行数を取ってマッチングに使う
    const matchWindowSize = Math.min(prevLines.length, 5);
    const matchWindow = prevLines.slice(-matchWindowSize);

    // 今回の出力内で matchWindow と一致する箇所を末尾から探す
    for (let i = currentLines.length - matchWindowSize; i >= 0; i--) {
      const candidate = currentLines.slice(i, i + matchWindowSize);
      if (candidate.every((line, idx) => line === matchWindow[idx])) {
        const newLines = currentLines.slice(i + matchWindowSize);
        if (newLines.length === 0) {
          return "";
        }
        return newLines.join("\n");
      }
    }

    // マッチ箇所が見つからない場合（画面がクリアされた等）は全体を差分とみなす
    return current;
  }
}
