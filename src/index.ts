import { type TextChannel, type ThreadChannel } from "discord.js";
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { sessionStore } from "./sessions/store.ts";
import { createDiscordClient } from "./bot/client.ts";
import { handleMessage, handleThreadCreate } from "./bot/handler.ts";
import { sendToDiscord } from "./bot/responder.ts";
import { createSession, hasSession, killSession } from "./tmux/manager.ts";
import { OutputWatcher } from "./tmux/watcher.ts";
import type { OutputEvent } from "./types.ts";

const logger = createLogger("main");

const MAIN_SESSION_NAME = "main";

async function main(): Promise<void> {
  logger.info("Starting discord-agent-bot...");

  // 1. Discord クライアント初期化
  const discord = createDiscordClient();

  // 2. メインセッション作成（既存セッションがあれば再作成）
  const sessionExists = await hasSession(MAIN_SESSION_NAME);
  if (sessionExists) {
    logger.warn("Existing main session found, killing and recreating...");
    await killSession(MAIN_SESSION_NAME);
  }
  logger.info(`Creating main session (cwd: ${config.defaultCwd})`);
  await createSession(MAIN_SESSION_NAME, config.defaultCwd);

  // 3. SessionStore にメインセッションを登録
  sessionStore.registerSession(null, {
    name: MAIN_SESSION_NAME,
    cwd: config.defaultCwd,
    threadId: null,
    isMain: true,
  });

  // 4. OutputWatcher を起動してメインセッションを監視
  const watcher = new OutputWatcher();
  watcher.watch(MAIN_SESSION_NAME);

  // 5. OutputWatcher の "output" イベントで Discord に投稿
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
        }
      }
    })();
  });

  // 6. messageCreate で handler を呼ぶ
  discord.onMessage((message) => {
    void handleMessage(message);
  });

  // 7. threadCreate でスレッドセッションを起動
  discord.onThreadCreate((thread, newlyCreated) => {
    void handleThreadCreate(thread, newlyCreated, watcher);
  });

  // 8. Discord クライアントにログイン
  await discord.login();
  logger.info("Bot is ready");
}

main().catch((error: unknown) => {
  logger.error(`Fatal error: ${String(error)}`);
  process.exit(1);
});
