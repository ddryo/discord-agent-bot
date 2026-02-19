import type { TextChannel, ThreadChannel } from "discord.js";
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { sessionStore } from "./sessions/store.ts";
import { createDiscordClient } from "./bot/client.ts";
import { handleMessage, handleThreadCreate, setWatcher } from "./bot/handler.ts";
import { sendToDiscord, sendSessionStartNotification, sendSessionEndNotification } from "./bot/responder.ts";
import { handleInteraction, sendToolApproval, sendAskUser, getPendingInteraction, clearPendingInteraction } from "./bot/interactions.ts";
import type { ToolApprovalInfo, AskUserInfo } from "./types.ts";
import { createSession, hasSession, killSession, listSessions, checkDependencies } from "./tmux/manager.ts";
import { OutputWatcher } from "./tmux/watcher.ts";
import type { OutputEvent } from "./types.ts";

const logger = createLogger("main");

const MAIN_SESSION_NAME = "main";

async function main(): Promise<void> {
  logger.info("Starting discord-agent-bot...");

  // 0. シグナルハンドラを早期登録（初期化途中でもクリーンアップ可能にする）
  let isShuttingDown = false;
  let watcher: OutputWatcher | undefined;
  let discord: ReturnType<typeof createDiscordClient> | undefined;

  async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal}, shutting down...`);

    // 1. OutputWatcher の全監視を停止
    watcher?.unwatchAll();

    // 2. 全 tmux セッション（ccbot- プレフィックス）を killSession
    const sessions = await listSessions();
    for (const fullName of sessions) {
      const name = fullName.replace(/^ccbot-/, "");
      await killSession(name);
    }

    // 3. Discord クライアントの切断
    if (discord) {
      await discord.destroy();
    }

    logger.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

  // 0.5. 起動時ヘルスチェック
  const versions = await checkDependencies();
  logger.info(`Dependencies: tmux=${versions.tmux}, claude=${versions.claude}`);

  // 1. Discord クライアント初期化
  discord = createDiscordClient();

  // 2. メインセッション作成（既存セッションがあれば再作成）
  const sessionExists = await hasSession(MAIN_SESSION_NAME);
  if (sessionExists) {
    logger.warn("Existing main session found, killing and recreating...");
    await killSession(MAIN_SESSION_NAME);
  }
  logger.info(`Creating main session (cwd: ${config.defaultCwd})`);
  await createSession(MAIN_SESSION_NAME, config.defaultCwd);

  // 3. SessionStore にメインセッションを登録
  // メインセッションは await createSession() 後に登録するため readyPromise は不要
  sessionStore.registerSession(null, {
    name: MAIN_SESSION_NAME,
    cwd: config.defaultCwd,
    threadId: null,
    isMain: true,
  });

  // 4. OutputWatcher を作成（ログイン後に監視開始）
  watcher = new OutputWatcher();

  // handler.ts から watcher を利用できるよう設定
  setWatcher(watcher);

  // 5. messageCreate で handler を呼ぶ
  discord.onMessage((message) => {
    void handleMessage(message);
  });

  // 6. threadCreate でスレッドセッションを起動
  discord.onThreadCreate((thread, newlyCreated) => {
    void handleThreadCreate(thread, newlyCreated, watcher);
  });

  // 6.5. interactionCreate でボタン応答を処理
  discord.onInteraction((interaction) => {
    void handleInteraction(interaction);
  });

  // 7. Discord クライアントにログイン
  await discord.login();

  // 8. OutputWatcher の "output" イベントで Discord に投稿
  //    ログイン後に登録し、チャンネルキャッシュが利用可能な状態で動作させる
  watcher.on("output", (sessionName: string, events: OutputEvent[]) => {
    void (async () => {
      let target: TextChannel | ThreadChannel | undefined;

      if (sessionName === MAIN_SESSION_NAME) {
        // メインセッション → メインチャンネル
        target = discord.client.channels.cache.get(
          config.discordChannelId,
        ) as TextChannel | undefined;
      } else {
        // スレッドセッション → sessionName から threadId を特定
        const session = sessionStore.getSessionByName(sessionName);
        if (session?.threadId) {
          target = discord.client.channels.cache.get(
            session.threadId,
          ) as ThreadChannel | undefined;
        }
      }

      if (!target) {
        logger.error(`Target channel not found for session: ${sessionName}`);
        return;
      }

      for (const event of events) {
        if (event.type === "text" && event.content) {
          await sendToDiscord(target, event.content);
        } else if (event.type === "tool_approval" && event.metadata) {
          // 既に pending の場合は重複通知をスキップ
          if (!getPendingInteraction(sessionName)) {
            await sendToolApproval(target, sessionName, event.metadata as ToolApprovalInfo);
          }
        } else if (event.type === "ask_user" && event.metadata) {
          if (!getPendingInteraction(sessionName)) {
            await sendAskUser(target, sessionName, event.metadata as AskUserInfo);
          }
        }
        if (event.type === "session_end") {
          // セッション終了通知 + クリーンアップ
          const session = sessionStore.getSessionByName(sessionName);
          await sendSessionEndNotification(target, "normal");

          if (session) {
            sessionStore.removeSession(session.threadId);
          }
          watcher.unwatch(sessionName);
          clearPendingInteraction(sessionName);
          logger.info(`Session ended: ${sessionName}`);
        }
      }
    })();
  });

  // 8.5. session_dead イベントで Discord にエラー通知 + クリーンアップ
  watcher.on("session_dead", (sessionName: string) => {
    void (async () => {
      const session = sessionStore.getSessionByName(sessionName);

      // Discord チャンネルにエラー通知を投稿
      let target: TextChannel | ThreadChannel | undefined;
      if (sessionName === MAIN_SESSION_NAME) {
        target = discord.client.channels.cache.get(
          config.discordChannelId,
        ) as TextChannel | undefined;
      } else if (session?.threadId) {
        target = discord.client.channels.cache.get(
          session.threadId,
        ) as ThreadChannel | undefined;
      }

      if (target) {
        await sendSessionEndNotification(target, "error");
      }

      // クリーンアップ
      if (session) {
        sessionStore.removeSession(session.threadId);
      }
      clearPendingInteraction(sessionName);
      logger.warn(`Session dead cleaned up: ${sessionName}`);
    })();
  });

  // 9. メインセッションの監視開始（ログイン完了後に開始）
  watcher.watch(MAIN_SESSION_NAME);

  // 9.5. メインセッション起動通知
  const mainChannel = discord.client.channels.cache.get(
    config.discordChannelId,
  ) as TextChannel | undefined;
  if (mainChannel) {
    await sendSessionStartNotification(mainChannel, MAIN_SESSION_NAME, config.defaultCwd);
  }

  logger.info("Bot is ready");
}

// Bot 全体のクラッシュ防止
process.on("unhandledRejection", (reason: unknown) => {
  logger.error(`Unhandled rejection: ${String(reason)}`);
});

process.on("uncaughtException", (error: Error) => {
  logger.error(`Uncaught exception: ${error.message}\n${error.stack ?? ""}`);
});

main().catch((error: unknown) => {
  logger.error(`Fatal error: ${String(error)}`);
  process.exit(1);
});
